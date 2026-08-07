import { describe, expect, test } from "bun:test";
import { Scheduler, type Action, type GenView } from "./scheduler.ts";
import type { Geometry } from "./geometry.ts";
import { imageId } from "./kitty.ts";
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
  maxResident: 64,
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
});

describe("trigger coalescing", () => {
  test("two triggers while running lead to exactly one re-run afterwards", () => {
    const s = new Scheduler(GEO);
    s.dispatch({ type: "trigger" });
    s.dispatch({ type: "renderDone", gen: 1, documentHeightPx: 1500 });
    s.dispatch({ type: "tileReady", gen: 1, tileIndex: 0 });
    expect(s.dispatch({ type: "trigger" })).toEqual([]);
    expect(s.dispatch({ type: "trigger" })).toEqual([]);
    s.dispatch({ type: "tileReady", gen: 1, tileIndex: 1 });
    const last = s.dispatch({ type: "tileReady", gen: 1, tileIndex: 2 });
    expect(last.filter((a) => a.type === "render")).toEqual([{ type: "render", gen: 2 }]);
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
    maxResident: 64,
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

    s.dispatch({ type: "key", delta: { kind: "bottom" } });
    expect(s.dispatch({ type: "trigger" }).filter((a) => a.type === "render")).toEqual([
      { type: "render", gen: 2 },
    ]);
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
