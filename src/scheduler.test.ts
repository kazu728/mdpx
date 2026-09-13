import { describe, expect, test } from "bun:test";
import { Scheduler, type Action, type GenView } from "./scheduler.ts";
import type { Geometry } from "./geometry.ts";
import { IMAGE_ID_GENERATION_STRIDE, imageId } from "./kitty.ts";
import { alignedTileHeightPx, visibleTiles } from "./viewport.ts";

const GEO: Geometry = {
  rows: 51,
  cols: 10,
  cellHpx: 10,
  imgWidthPx: 200,
  viewportWidthCssPx: 100,
  renderScale: 2,
  tileHeightPx: alignedTileHeightPx(10, 50),
  exceedsFrameLimit: false,
  exceedsStorage: false,
  maxResident: 64,
  maxTotalResident: 128,
};
const shoots = (as: Action[]) =>
  as.filter((a): a is Action & { type: "shoot" } => a.type === "shoot").map((a) => a.tileIndex);
const has = (as: Action[], t: Action["type"]) => as.some((a) => a.type === t);
function shown(s: Scheduler): GenView {
  const v = s.viewState();
  if (v.displayGen === null) throw new Error("no generation is displayed");
  return v;
}

function newDisplayedGen1(): Scheduler {
  const s = new Scheduler(GEO);
  s.dispatch({ type: "trigger" });
  s.dispatch({ type: "renderDone", gen: 1, documentHeightPx: 1500 });
  s.dispatch({ type: "tileReady", gen: 1, tileIndex: 0 });
  s.dispatch({ type: "tileReady", gen: 1, tileIndex: 1 });
  s.dispatch({ type: "tileReady", gen: 1, tileIndex: 2 });
  return s;
}

describe("pipeline basics", () => {
  test("trigger returns render + redraw", () => {
    const s = new Scheduler(GEO);
    expect(s.dispatch({ type: "trigger" })).toEqual([
      { type: "render", gen: 1 },
      { type: "redraw" },
    ]);
  });

  test("renderDone captures the first tile, visible-first (the clip is cell-aligned CSS px)", () => {
    const s = new Scheduler(GEO);
    s.dispatch({ type: "trigger" });
    expect(s.dispatch({ type: "renderDone", gen: 1, documentHeightPx: 1500 })).toEqual([
      {
        type: "shoot",
        gen: 1,
        tileIndex: 0,
        clip: { xCssPx: 0, yCssPx: 0, widthCssPx: 100, heightCssPx: 250 },
      },
    ]);
  });

  test("promotes once the visible tiles are in, with no old generation to delete the first time", () => {
    const s = new Scheduler(GEO);
    s.dispatch({ type: "trigger" });
    s.dispatch({ type: "renderDone", gen: 1, documentHeightPx: 1500 });
    const b = s.dispatch({ type: "tileReady", gen: 1, tileIndex: 0 });
    expect(has(b, "deleteGen")).toBe(false);
    expect(shoots(b)).toEqual([1]);
    expect(s.viewState().displayGen).toBe(1);
    expect(shown(s).resident.has(0)).toBe(true);
  });

  test("phase is ready once every tile is captured", () => {
    expect(newDisplayedGen1().viewState().phase).toBe("ready");
  });
});

describe("generation switch", () => {
  test("deletes the old generation after placing the new one and clamps scrollPx to the new document height", () => {
    const s = newDisplayedGen1();
    s.dispatch({ type: "key", delta: { kind: "bottom" } });
    expect<number>(s.viewState().scrollPx).toBe(1000);

    s.dispatch({ type: "trigger" });
    expect(shoots(s.dispatch({ type: "renderDone", gen: 2, documentHeightPx: 500 }))).toEqual([0]);
    const p = s.dispatch({ type: "tileReady", gen: 2, tileIndex: 0 });

    const idxRedraw = p.findIndex((a) => a.type === "redraw");
    const idxDelete = p.findIndex((a) => a.type === "deleteGen");
    expect(idxRedraw).toBeGreaterThanOrEqual(0);
    expect(idxDelete).toBeGreaterThan(idxRedraw);
    const del = p.find((a): a is Action & { type: "deleteGen" } => a.type === "deleteGen");
    expect(del!.imageIds.slice().sort()).toEqual(
      [imageId(1, 0), imageId(1, 1), imageId(1, 2)].sort(),
    );
    expect(s.viewState().displayGen).toBe(2);
    expect<number>(s.viewState().scrollPx).toBe(0);
  });

  test("a regeneration at the same document height keeps scrollPx", () => {
    const s = newDisplayedGen1();
    s.dispatch({ type: "key", delta: { kind: "lines", n: 20 } });
    const before = s.viewState().scrollPx;
    expect<number>(before).toBeGreaterThan(0);

    s.dispatch({ type: "trigger" });
    s.dispatch({ type: "renderDone", gen: 2, documentHeightPx: 1500 });
    expect<number>(s.viewState().scrollPx).toBe(before);
  });
});

describe("trigger coalescing", () => {
  test("two triggers during layout start exactly one new generation as soon as layout settles", () => {
    const s = new Scheduler(GEO);
    s.dispatch({ type: "trigger" });
    expect(s.dispatch({ type: "trigger" })).toEqual([]);
    expect(s.dispatch({ type: "trigger" })).toEqual([]);
    const next = s.dispatch({ type: "renderDone", gen: 1, documentHeightPx: 1500 });
    expect(next.filter((a) => a.type === "shoot")).toEqual([]);
    expect(next.filter((a) => a.type === "render")).toEqual([{ type: "render", gen: 2 }]);
  });

  test("a save during capture drops the rest of the stale queue after the in-flight tile", () => {
    const s = new Scheduler(GEO);
    s.dispatch({ type: "trigger" });
    s.dispatch({ type: "renderDone", gen: 1, documentHeightPx: 1500 });
    s.dispatch({ type: "trigger" });

    const next = s.dispatch({ type: "tileReady", gen: 1, tileIndex: 0 });
    expect(shoots(next)).toEqual([]);
    expect(next.filter((a) => a.type === "deleteGen")).toEqual([
      { type: "deleteGen", imageIds: [imageId(1, 0)] },
    ]);
    expect(next.filter((a) => a.type === "render")).toEqual([{ type: "render", gen: 2 }]);
  });

  test("a tile captured after promotion remains resident when the rest of its queue is superseded", () => {
    const s = new Scheduler(GEO);
    s.dispatch({ type: "trigger" });
    s.dispatch({ type: "renderDone", gen: 1, documentHeightPx: 1500 });
    s.dispatch({ type: "tileReady", gen: 1, tileIndex: 0 });
    s.dispatch({ type: "trigger" });

    const next = s.dispatch({ type: "tileReady", gen: 1, tileIndex: 1 });
    expect(next.filter((a) => a.type === "deleteGen")).toEqual([]);
    expect(next.filter((a) => a.type === "render")).toEqual([{ type: "render", gen: 2 }]);
    expect(shown(s).resident.has(1)).toBe(true);
  });

  test("superseding an unpromoted generation frees every tile already transferred for it", () => {
    const s = newDisplayedGen1();
    s.dispatch({ type: "key", delta: { kind: "lines", n: 10 } });
    s.dispatch({ type: "trigger" });
    s.dispatch({ type: "renderDone", gen: 2, documentHeightPx: 1500 });
    s.dispatch({ type: "tileReady", gen: 2, tileIndex: 0 });
    s.dispatch({ type: "trigger" });

    const next = s.dispatch({ type: "tileReady", gen: 2, tileIndex: 1 });
    expect(next.filter((a) => a.type === "deleteGen")).toEqual([
      { type: "deleteGen", imageIds: [imageId(2, 0), imageId(2, 1)] },
    ]);
    expect(next.filter((a) => a.type === "render")).toEqual([{ type: "render", gen: 3 }]);
    expect(s.viewState().displayGen).toBe(1);
  });
});

describe("scrolling to an untransferred tile", () => {
  test("blank, then the capture order is rebuilt, then the transfer places it", () => {
    const s = new Scheduler(GEO);
    s.dispatch({ type: "trigger" });
    s.dispatch({ type: "renderDone", gen: 1, documentHeightPx: 1500 });
    s.dispatch({ type: "tileReady", gen: 1, tileIndex: 0 });

    const k = s.dispatch({ type: "key", delta: { kind: "bottom" } });
    expect(has(k, "redraw")).toBe(true);
    const vs = shown(s);
    const vis = visibleTiles(vs.scrollPx, 50, 10, vs.tiles).map((p) => p.tileIndex);
    expect(vis).toContain(2);
    expect(vs.resident.has(2)).toBe(false);

    expect(shoots(s.dispatch({ type: "tileReady", gen: 1, tileIndex: 1 }))).toEqual([2]);
    const after = s.dispatch({ type: "tileReady", gen: 1, tileIndex: 2 });
    expect(has(after, "redraw")).toBe(true);
    expect(shown(s).resident.has(2)).toBe(true);
  });
});

describe("scrolling when downscaled", () => {
  const REDUCED: Geometry = {
    rows: 65,
    cols: 216,
    cellHpx: 31,
    imgWidthPx: 1512,
    viewportWidthCssPx: 1512,
    renderScale: 1,
    tileHeightPx: alignedTileHeightPx(31, 64),
    exceedsFrameLimit: false,
    exceedsStorage: false,
    maxResident: 64,
    maxTotalResident: 128,
  };

  function displayed(): Scheduler {
    const s = new Scheduler(REDUCED);
    s.dispatch({ type: "trigger" });
    s.dispatch({ type: "renderDone", gen: 1, documentHeightPx: 100000 });
    for (let i = 0; s.viewState().phase === "rendering" && i < 200; i++) {
      s.dispatch({ type: "tileReady", gen: 1, tileIndex: i });
    }
    return s;
  }

  test.each([
    ["lines", { kind: "lines", n: 1 } as const, { kind: "lines", n: -1 } as const],
    ["halfpage", { kind: "halfpage", dir: 1 } as const, { kind: "halfpage", dir: -1 } as const],
  ])("%s returns to the original position on a round trip", (_name, down, up) => {
    const s = displayed();
    for (let i = 0; i < 3; i++) {
      const before = s.viewState().scrollPx;
      s.dispatch({ type: "key", delta: down });
      expect(s.viewState().scrollPx).toBeGreaterThan(before);
      s.dispatch({ type: "key", delta: up });
      expect(s.viewState().scrollPx).toBe(before);
    }
  });

  test("the scroll position is always a multiple of the unit (2 cells)", () => {
    const s = displayed();
    for (const delta of [
      { kind: "lines", n: 3 } as const,
      { kind: "halfpage", dir: 1 } as const,
      { kind: "bottom" } as const,
      { kind: "halfpage", dir: -1 } as const,
    ]) {
      s.dispatch({ type: "key", delta });
      expect(s.viewState().scrollPx % 62).toBe(0);
    }
  });
});

describe("resize", () => {
  test("a resize mid-run discards the current generation, re-runs at the new geometry, and frees transferred tiles", () => {
    const s = new Scheduler(GEO);
    s.dispatch({ type: "trigger" });
    s.dispatch({ type: "renderDone", gen: 1, documentHeightPx: 1500 });
    const bigger: Geometry = {
      ...GEO,
      rows: 61,
      cellHpx: 12,
      tileHeightPx: alignedTileHeightPx(12, 60),
    };
    const r = s.dispatch({ type: "resize", geometry: bigger });
    expect(r).toEqual([{ type: "redraw" }]);
    expect(s.viewState().displayGen).toBe(null);
    const back = s.dispatch({ type: "tileReady", gen: 1, tileIndex: 0 });
    expect(back.filter((a) => a.type === "deleteGen")).toEqual([
      { type: "deleteGen", imageIds: [imageId(1, 0)] },
    ]);
    expect(back.filter((a) => a.type === "render")).toEqual([{ type: "render", gen: 2 }]);
    expect(s.viewState().geometry.cellHpx).toBe(12);
  });

  test("resizing a displayed generation (pipeline already finished) frees every transferred image", () => {
    const s = newDisplayedGen1();
    const r = s.dispatch({ type: "resize", geometry: { ...GEO, rows: 41 } });
    const del = r.find((a): a is Action & { type: "deleteGen" } => a.type === "deleteGen");
    expect(del!.imageIds.slice().sort()).toEqual(
      [imageId(1, 0), imageId(1, 1), imageId(1, 2)].sort(),
    );
    expect(r.filter((a) => a.type === "render")).toEqual([{ type: "render", gen: 2 }]);
  });

  test("an in-flight tile of a discarded generation is freed individually (orphan)", () => {
    const s = new Scheduler(GEO);
    s.dispatch({ type: "trigger" });
    s.dispatch({ type: "renderDone", gen: 1, documentHeightPx: 1500 });
    s.dispatch({ type: "resize", geometry: { ...GEO, rows: 61 } });
    s.dispatch({ type: "tileReady", gen: 1, tileIndex: 0 });
    const orphan = s.dispatch({ type: "tileReady", gen: 1, tileIndex: 5 });
    expect(orphan).toEqual([{ type: "deleteGen", imageIds: [imageId(1, 5)] }]);
  });

  test("a resize reporting the current geometry keeps the display and starts nothing", () => {
    const s = newDisplayedGen1();
    const r = s.dispatch({ type: "resize", geometry: { ...GEO } });
    expect(r).toEqual([{ type: "redraw" }]);
    expect(s.viewState().displayGen).toBe(1);
    expect(shown(s).resident.size).toBe(3);
  });
});

describe("consuming the capture queue", () => {
  test("after a scroll rebuilds the queue, transferred tiles are not recaptured and the pipeline completes", () => {
    const s = new Scheduler(GEO);
    s.dispatch({ type: "trigger" });
    s.dispatch({ type: "renderDone", gen: 1, documentHeightPx: 1500 });
    s.dispatch({ type: "tileReady", gen: 1, tileIndex: 0 });
    s.dispatch({ type: "key", delta: { kind: "bottom" } });
    expect(shoots(s.dispatch({ type: "tileReady", gen: 1, tileIndex: 1 }))).toEqual([2]);

    const last = s.dispatch({ type: "tileReady", gen: 1, tileIndex: 2 });
    expect(shoots(last)).toEqual([]);
    expect(s.viewState().phase).toBe("ready");
  });

  test("a tileReady that promotes redraws exactly once (never re-placing what it just placed)", () => {
    const s = newDisplayedGen1();
    s.dispatch({ type: "trigger" });
    s.dispatch({ type: "renderDone", gen: 2, documentHeightPx: 1500 });
    const p = s.dispatch({ type: "tileReady", gen: 2, tileIndex: 0 });
    expect(p.filter((a) => a.type === "redraw").length).toBe(1);
    expect(p[0]).toEqual({ type: "redraw" });
  });
});

describe("scrolling during an unpromoted pipeline", () => {
  test("the capture order is rebuilt around the new scroll position and promotion needs only the visible tiles", () => {
    const s = newDisplayedGen1();
    s.dispatch({ type: "trigger" });
    expect(shoots(s.dispatch({ type: "renderDone", gen: 2, documentHeightPx: 1500 }))).toEqual([0]);
    s.dispatch({ type: "key", delta: { kind: "bottom" } });
    expect(shoots(s.dispatch({ type: "tileReady", gen: 2, tileIndex: 0 }))).toEqual([2]);
    const p = s.dispatch({ type: "tileReady", gen: 2, tileIndex: 2 });
    expect(has(p, "deleteGen")).toBe(true);
    expect(s.viewState().displayGen).toBe(2);
  });
});

describe("renderFailed", () => {
  test("folds the pipeline, keeps the current frame, and lets the next trigger through normally", () => {
    const s = newDisplayedGen1();
    s.dispatch({ type: "trigger" });
    const f = s.dispatch({ type: "renderFailed", gen: 2 });
    expect(has(f, "redraw")).toBe(true);
    expect(has(f, "render")).toBe(false);
    expect(s.viewState().phase).toBe("ready");
    expect(s.viewState().displayGen).toBe(1);
    expect(s.dispatch({ type: "trigger" }).filter((a) => a.type === "render")).toEqual([
      { type: "render", gen: 3 },
    ]);
  });

  test("a trigger coalesced during the run re-runs immediately after the failure", () => {
    const s = newDisplayedGen1();
    s.dispatch({ type: "trigger" });
    s.dispatch({ type: "trigger" });
    const f = s.dispatch({ type: "renderFailed", gen: 2 });
    expect(f.filter((a) => a.type === "render")).toEqual([{ type: "render", gen: 3 }]);
  });

  test("an unpromoted boundary-straddling generation failing mid-backfill frees its transferred images", () => {
    const s = newDisplayedGen1();
    s.dispatch({ type: "key", delta: { kind: "lines", n: 10 } });
    s.dispatch({ type: "trigger" });
    s.dispatch({ type: "renderDone", gen: 2, documentHeightPx: 1500 });
    s.dispatch({ type: "tileReady", gen: 2, tileIndex: 0 });
    expect(s.viewState().displayGen).toBe(1);

    const f = s.dispatch({ type: "renderFailed", gen: 2 });
    expect(f.filter((a) => a.type === "deleteGen")).toEqual([
      { type: "deleteGen", imageIds: [imageId(2, 0)] },
    ]);
    expect(s.viewState().displayGen).toBe(1);
  });

  test("a promoted generation failing keeps the displayed images, recapturable by a later trigger", () => {
    const s = new Scheduler(GEO);
    s.dispatch({ type: "trigger" });
    s.dispatch({ type: "renderDone", gen: 1, documentHeightPx: 1500 });
    s.dispatch({ type: "tileReady", gen: 1, tileIndex: 0 });

    const f = s.dispatch({ type: "renderFailed", gen: 1 });
    expect(has(f, "deleteGen")).toBe(false);
    expect(s.viewState().displayGen).toBe(1);
    expect(shown(s).resident.has(0)).toBe(true);
    expect(s.viewState().phase).toBe("ready");
    expect(s.viewState().failure).toBe(false);

    s.dispatch({ type: "key", delta: { kind: "bottom" } });
    expect(s.dispatch({ type: "trigger" }).filter((a) => a.type === "render")).toEqual([
      { type: "render", gen: 2 },
    ]);
  });

  test("a failed first render flags failure with no display", () => {
    const s = new Scheduler(GEO);
    s.dispatch({ type: "trigger" });
    expect(s.viewState().failure).toBe(false);
    s.dispatch({ type: "renderFailed", gen: 1 });
    expect(s.viewState().displayGen).toBe(null);
    expect(s.viewState().failure).toBe(true);
  });

  test("a failed update keeps the display, flags failure, and clears it on the next success", () => {
    const s = newDisplayedGen1();
    s.dispatch({ type: "trigger" });
    s.dispatch({ type: "renderFailed", gen: 2 });
    expect(s.viewState().displayGen).toBe(1);
    expect(s.viewState().failure).toBe(true);

    s.dispatch({ type: "trigger" });
    expect(s.viewState().failure).toBe(true);
    let acts = s.dispatch({ type: "renderDone", gen: 3, documentHeightPx: 1500 });
    for (let i = 0; i < 20; i++) {
      const sh = shoots(acts);
      if (!sh.length) break;
      acts = s.dispatch({ type: "tileReady", gen: 3, tileIndex: sh[0]! });
    }
    expect(s.viewState().displayGen).toBe(3);
    expect(s.viewState().failure).toBe(false);
  });
});

describe("resident tile budget", () => {
  const SMALL: Geometry = { ...GEO, maxResident: 3 };

  function displayed(): Scheduler {
    const s = new Scheduler(SMALL);
    s.dispatch({ type: "trigger" });
    let acts = s.dispatch({ type: "renderDone", gen: 1, documentHeightPx: 5000 });
    for (let i = 0; i < 20; i++) {
      const sh = shoots(acts);
      if (!sh.length) break;
      acts = s.dispatch({ type: "tileReady", gen: 1, tileIndex: sh[0]! });
    }
    return s;
  }

  test("residency never exceeds the budget (nothing is left for the terminal to evict)", () => {
    const s = displayed();
    expect(shown(s).resident.size).toBeLessThanOrEqual(3);
  });

  test("the pipeline completes once the budget is captured (it does not capture all ten)", () => {
    const s = displayed();
    expect(s.viewState().phase).toBe("ready");
    expect(shown(s).resident.size).toBeLessThan(10);
  });

  test("scrolling far frees old tiles, and that comes after the placement (redraw)", () => {
    const s = displayed();
    const before = new Set(shown(s).resident);
    let acts = s.dispatch({ type: "key", delta: { kind: "bottom" } });
    let sawEvict = false;
    for (let i = 0; i < 20; i++) {
      const sh = shoots(acts);
      if (!sh.length) break;
      acts = s.dispatch({ type: "tileReady", gen: 1, tileIndex: sh[0]! });
      const d = acts.findIndex((a) => a.type === "deleteGen");
      if (d >= 0) {
        sawEvict = true;
        expect(acts.findIndex((a) => a.type === "redraw")).toBeLessThan(d);
      }
    }
    expect(sawEvict).toBe(true);
    expect(shown(s).resident.size).toBeLessThanOrEqual(3);
    expect([...before].some((t) => !shown(s).resident.has(t))).toBe(true);
  });

  test("visible tiles are never freed (no black hole in what is on screen)", () => {
    const s = displayed();
    const vs = shown(s);
    const vis = visibleTiles(vs.scrollPx, 50, 10, vs.tiles).map((p) => p.tileIndex);
    expect(vis.length).toBeGreaterThan(0);
    for (const t of vis) expect(vs.resident.has(t)).toBe(true);
  });

  test("scrolling outside residency goes back to capturing (nothing is left black)", () => {
    const s = displayed();
    const acts = s.dispatch({ type: "key", delta: { kind: "bottom" } });
    expect(shoots(acts).length).toBeGreaterThan(0);
    expect(s.viewState().phase).toBe("ready");
  });

  test("scrolling toward a tile prefetches it before it becomes visible", () => {
    const s = new Scheduler({ ...GEO, maxResident: 2 });
    s.dispatch({ type: "trigger" });
    s.dispatch({ type: "renderDone", gen: 1, documentHeightPx: 1500 });
    s.dispatch({ type: "tileReady", gen: 1, tileIndex: 0 });
    s.dispatch({ type: "tileReady", gen: 1, tileIndex: 1 });

    expect(shoots(s.dispatch({ type: "key", delta: { kind: "halfpage", dir: 1 } }))).toEqual([]);
    const actions = s.dispatch({ type: "key", delta: { kind: "halfpage", dir: 1 } });
    const view = shown(s);
    expect(visibleTiles(view.scrollPx, 50, 10, view.tiles).map((p) => p.tileIndex)).toEqual([1]);
    expect(actions.findIndex((a) => a.type === "redraw")).toBeLessThan(
      actions.findIndex((a) => a.type === "deleteGen"),
    );
    expect(actions.findIndex((a) => a.type === "deleteGen")).toBeLessThan(
      actions.findIndex((a) => a.type === "shoot"),
    );
    expect(actions.filter((a) => a.type === "deleteGen")).toEqual([
      { type: "deleteGen", imageIds: [imageId(1, 0)] },
    ]);
    expect(shoots(actions)).toEqual([2]);
  });

  test("a save during a recapture yields to the new generation (no waiting on images about to be dropped)", () => {
    const s = displayed();
    s.dispatch({ type: "key", delta: { kind: "bottom" } });
    expect(s.dispatch({ type: "trigger" }).filter((a) => a.type === "render")).toEqual([
      { type: "render", gen: 2 },
    ]);
  });

  test("a late capture from a recapture is taken into the displayed generation rather than dropped", () => {
    const s = displayed();
    const acts = s.dispatch({ type: "key", delta: { kind: "bottom" } });
    const inFlight = shoots(acts)[0]!;
    s.dispatch({ type: "trigger" });
    const late = s.dispatch({ type: "tileReady", gen: 1, tileIndex: inFlight });
    expect(late.some((a) => a.type === "deleteGen" && a.imageIds.includes(imageId(1, inFlight)))).toBe(false);
    expect(shown(s).resident.has(inFlight)).toBe(true);
  });
});

describe("cross-generation storage", () => {
  const TIGHT: Geometry = { ...GEO, maxResident: 3, maxTotalResident: 4 };
  const LOOSE: Geometry = { ...GEO, maxResident: 3, maxTotalResident: 128 };

  interface UpdateRecord {
    prePromotionTrims: number[];
    promotionDeletes: number[];
    prePromotionShoots: number[];
  }

  function runStraddledUpdate(geo: Geometry): UpdateRecord {
    const s = new Scheduler(geo);
    s.dispatch({ type: "trigger" });
    let acts = s.dispatch({ type: "renderDone", gen: 1, documentHeightPx: 5000 });
    for (let i = 0; i < 20; i++) {
      const sh = shoots(acts);
      if (!sh.length) break;
      acts = s.dispatch({ type: "tileReady", gen: 1, tileIndex: sh[0]! });
    }
    s.dispatch({ type: "key", delta: { kind: "lines", n: 10 } });
    const atScroll = shown(s);
    const visibleOld = new Set(
      visibleTiles(atScroll.scrollPx, 50, 10, atScroll.tiles).map((p) => p.tileIndex),
    );
    expect([...visibleOld].sort()).toEqual([0, 1]);

    const oldAlive = new Set<number>(atScroll.resident);
    const newAlive = new Set<number>();
    const rec: UpdateRecord = { prePromotionTrims: [], promotionDeletes: [], prePromotionShoots: [] };
    let promoted = false;

    const applyBatch = (batch: Action[]) => {
      const promotionBatch = !promoted && s.viewState().displayGen === 2;
      for (const a of batch) {
        if (a.type !== "deleteGen") continue;
        for (const id of a.imageIds) {
          const gen = Math.floor(id / IMAGE_ID_GENERATION_STRIDE);
          const idx = id % IMAGE_ID_GENERATION_STRIDE;
          if (gen === 1) {
            if (promotionBatch) rec.promotionDeletes.push(id);
            else {
              expect(visibleOld.has(idx)).toBe(false);
              rec.prePromotionTrims.push(id);
            }
            oldAlive.delete(idx);
          } else {
            newAlive.delete(idx);
          }
        }
      }
      for (const a of batch) {
        if (a.type !== "shoot" || a.gen !== 2) continue;
        if (promotionBatch || promoted) {
          expect(newAlive.size + 1).toBeLessThanOrEqual(geo.maxResident);
        } else {
          expect(visibleOld.has(a.tileIndex)).toBe(true);
          expect(oldAlive.size + newAlive.size + 1).toBeLessThanOrEqual(geo.maxTotalResident);
          rec.prePromotionShoots.push(a.tileIndex);
        }
        newAlive.add(a.tileIndex);
      }
      if (s.viewState().displayGen === 2) promoted = true;
    };

    s.dispatch({ type: "trigger" });
    acts = s.dispatch({ type: "renderDone", gen: 2, documentHeightPx: 5000 });
    applyBatch(acts);
    for (let i = 0; i < 20 && s.viewState().phase === "rendering"; i++) {
      const pending: number[] = [];
      const scan = (batch: Action[]) => {
        for (const a of batch) if (a.type === "shoot" && a.gen === 2) pending.push(a.tileIndex);
      };
      scan(acts);
      const next = pending[pending.length - 1]!;
      acts = s.dispatch({ type: "tileReady", gen: 2, tileIndex: next });
      applyBatch(acts);
    }
    expect(promoted).toBe(true);
    expect(s.viewState().phase).toBe("ready");
    expect(oldAlive.size).toBe(0);
    return rec;
  }

  test("a tight budget trims old read-ahead before new transfers, never visible tiles", () => {
    const rec = runStraddledUpdate(TIGHT);
    expect(rec.prePromotionShoots).toEqual([0, 1]);
    expect(rec.prePromotionTrims).toEqual([imageId(1, 2)]);
    expect(rec.promotionDeletes.slice().sort((a, b) => a - b)).toEqual(
      [imageId(1, 0), imageId(1, 1)].sort((a, b) => a - b),
    );
  });

  test("a loose budget performs no pre-promotion trim (control: the tight test discriminates)", () => {
    const rec = runStraddledUpdate(LOOSE);
    expect(rec.prePromotionShoots).toEqual([0, 1]);
    expect(rec.prePromotionTrims).toEqual([]);
    expect(rec.promotionDeletes.slice().sort((a, b) => a - b)).toEqual(
      [imageId(1, 0), imageId(1, 1), imageId(1, 2)].sort((a, b) => a - b),
    );
  });
});

describe("storage overflow single-generation mode", () => {
  const OVERFLOW: Geometry = {
    ...GEO,
    maxResident: 3,
    maxTotalResident: 3,
    exceedsFrameLimit: false,
    exceedsStorage: true,
  };

  function displayedGen1(): Scheduler {
    const s = new Scheduler(OVERFLOW);
    s.dispatch({ type: "trigger" });
    let acts = s.dispatch({ type: "renderDone", gen: 1, documentHeightPx: 5000 });
    for (let i = 0; i < 20; i++) {
      const sh = shoots(acts);
      if (!sh.length) break;
      acts = s.dispatch({ type: "tileReady", gen: 1, tileIndex: sh[0]! });
    }
    expect(s.viewState().displayGen).toBe(1);
    return s;
  }

  test("never transfers beyond maxTotalResident, dropping the old display first", () => {
    const s = displayedGen1();
    // Straddle a tile boundary so the new display needs two tiles: old visible [0,1] plus the
    // next transfer no longer fits, forcing the old display to go before the new display lands.
    s.dispatch({ type: "key", delta: { kind: "lines", n: 10 } });
    const atScroll = shown(s);
    expect(
      visibleTiles(atScroll.scrollPx, 50, 10, atScroll.tiles)
        .map((p) => p.tileIndex)
        .sort(),
    ).toEqual([0, 1]);
    s.dispatch({ type: "trigger" });
    let acts = s.dispatch({ type: "renderDone", gen: 2, documentHeightPx: 5000 });
    let liveOld = new Set<number>(shown(s).resident);
    let liveNew = new Set<number>();
    let prePromotionRelease = false;
    let sawNullBeforeDisplay = false;
    let promoted = false;
    for (let i = 0; i < 20 && s.viewState().phase === "rendering"; i++) {
      for (const a of acts) {
        if (a.type === "deleteGen") {
          for (const id of a.imageIds) {
            const gen = Math.floor(id / IMAGE_ID_GENERATION_STRIDE);
            const idx = id % IMAGE_ID_GENERATION_STRIDE;
            (gen === 1 ? liveOld : liveNew).delete(idx);
          }
        }
        if (a.type === "releaseGen" && a.gen === 1 && !promoted) prePromotionRelease = true;
        if (a.type === "shoot" && a.gen === 2) {
          // The transfer lands before tileReady, so live + 1 must still fit.
          expect(liveOld.size + liveNew.size + 1).toBeLessThanOrEqual(OVERFLOW.maxTotalResident);
          expect(liveNew.size + 1).toBeLessThanOrEqual(OVERFLOW.maxResident);
          liveNew.add(a.tileIndex);
        }
      }
      const pending = acts.filter(
        (a): a is Action & { type: "shoot" } => a.type === "shoot" && a.gen === 2,
      );
      if (!pending.length) break;
      acts = s.dispatch({ type: "tileReady", gen: 2, tileIndex: pending[pending.length - 1]!.tileIndex });
      if (s.viewState().displayGen === 2) promoted = true;
      else if (s.viewState().displayGen === null) sawNullBeforeDisplay = true;
      expect(liveOld.size + liveNew.size).toBeLessThanOrEqual(OVERFLOW.maxTotalResident);
    }
    expect(s.viewState().displayGen).toBe(2);
    // Old display must go before the new two-tile display lands (not at promotion).
    expect(prePromotionRelease).toBe(true);
    expect(sawNullBeforeDisplay).toBe(true);
  });

  test("promotion deletes old images and releases the old generation", () => {
    const s = displayedGen1();
    s.dispatch({ type: "trigger" });
    let acts = s.dispatch({ type: "renderDone", gen: 2, documentHeightPx: 5000 });
    let sawDelete = false;
    let sawRelease = false;
    for (let i = 0; i < 20 && s.viewState().phase === "rendering"; i++) {
      for (const a of acts) {
        if (a.type === "deleteGen" && a.imageIds.includes(imageId(1, 0))) sawDelete = true;
        if (a.type === "releaseGen" && a.gen === 1) sawRelease = true;
      }
      const pending = shoots(acts);
      if (!pending.length) break;
      acts = s.dispatch({ type: "tileReady", gen: 2, tileIndex: pending[pending.length - 1]! });
    }
    expect(s.viewState().displayGen).toBe(2);
    expect(sawDelete).toBe(true);
    expect(sawRelease).toBe(true);
  });

  test("a failed generation releases its files while the displayed generation keeps its own", () => {
    const s = displayedGen1();
    s.dispatch({ type: "trigger" });
    const f = s.dispatch({ type: "renderFailed", gen: 2 });
    expect(f.some((a) => a.type === "releaseGen" && a.gen === 2)).toBe(true);
    expect(f.some((a) => a.type === "releaseGen" && a.gen === 1)).toBe(false);
    expect(s.viewState().displayGen).toBe(1);
  });
});

describe("capped settle", () => {
  test("an undisplayable generation settles instead of sticking in rendering, retry and resize recover", async () => {
    const { resolveGeometry } = await import("./geometry.ts");
    const { detectGraphicsLimits } = await import("./capacity.ts");
    const relayed = detectGraphicsLimits({ HERDR_ENV: "1" });
    const cell = { cellHpx: 31, cellWpx: 14 };
    const geo400 = resolveGeometry({ cols: 400, rows: 400 }, cell, relayed);
    expect(geo400.exceedsStorage).toBe(true);
    const s = new Scheduler(geo400);
    s.dispatch({ type: "trigger" });
    let acts = s.dispatch({ type: "renderDone", gen: 1, documentHeightPx: 399 * 31 });
    let shots = 0;
    for (let i = 0; i < 300; i++) {
      const sh = shoots(acts);
      if (!sh.length) break;
      // Never overflow even while heading for the inevitable settle.
      acts = s.dispatch({ type: "tileReady", gen: 1, tileIndex: sh[0]! });
      shots++;
    }
    expect(shots).toBeGreaterThan(0);
    // Settled as capped, not stuck processing: no display, but ready for retry.
    expect(s.viewState().displayGen).toBe(null);
    expect(s.viewState().phase).toBe("ready");
    expect(shots).toBeLessThan(201);
    // Update retry issues work instead of going silent.
    expect(s.dispatch({ type: "trigger" }).some((a) => a.type === "render")).toBe(true);
  });

  test("resize from a settled generation restarts at the new geometry", async () => {
    const { resolveGeometry } = await import("./geometry.ts");
    const { detectGraphicsLimits } = await import("./capacity.ts");
    const relayed = detectGraphicsLimits({ HERDR_ENV: "1" });
    const cell = { cellHpx: 31, cellWpx: 14 };
    const s = new Scheduler(resolveGeometry({ cols: 400, rows: 400 }, cell, relayed));
    s.dispatch({ type: "trigger" });
    let acts = s.dispatch({ type: "renderDone", gen: 1, documentHeightPx: 399 * 31 });
    for (let i = 0; i < 300; i++) {
      const sh = shoots(acts);
      if (!sh.length) break;
      acts = s.dispatch({ type: "tileReady", gen: 1, tileIndex: sh[0]! });
    }
    expect(s.viewState().phase).toBe("ready");
    const geo80 = resolveGeometry({ cols: 80, rows: 24 }, cell, relayed);
    const r = s.dispatch({ type: "resize", geometry: geo80 });
    expect(r.some((a) => a.type === "render")).toBe(true);
    expect(s.viewState().geometry.cols).toBe(80);
  });
});
