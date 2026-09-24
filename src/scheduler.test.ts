import { describe, expect, test } from "bun:test";
import { Scheduler, type Action, type GenView } from "./scheduler.ts";
import type { Geometry } from "./geometry.ts";
import { detectGraphicsLimits, resolveGeometry } from "./geometry.ts";
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
const shoots = (as: Action[]) => as.filter((a) => a.type === "shoot").map((a) => (a as { tileIndex: number }).tileIndex);
const has = (as: Action[], t: Action["type"]) => as.some((a) => a.type === t);
const shown = (s: Scheduler) => { const v = s.viewState(); if (v.displayGen === null) throw new Error("none"); return v as GenView; };
function newDisplayedGen1(): Scheduler { const s = new Scheduler(GEO); s.dispatch({ type: "trigger" }); s.dispatch({ type: "renderDone", gen: 1, documentHeightPx: 1500 }); for (const i of [0, 1, 2]) s.dispatch({ type: "tileReady", gen: 1, tileIndex: i }); return s; }
function drain(s: Scheduler, acts: Action[], gen: number, n = 20) { for (let i = 0; i < n; i++) { const sh = shoots(acts); if (!sh.length) break; acts = s.dispatch({ type: "tileReady", gen, tileIndex: sh[0]! }); } return acts; }
function displayedWith(geo: Geometry, docH: number): Scheduler { const s = new Scheduler(geo); s.dispatch({ type: "trigger" }); let acts = s.dispatch({ type: "renderDone", gen: 1, documentHeightPx: docH }); for (let i = 0; i < 300 && s.viewState().phase === "rendering"; i++) { const sh = shoots(acts); if (!sh.length) break; acts = s.dispatch({ type: "tileReady", gen: 1, tileIndex: sh[0]! }); } return s; }

describe("pipeline basics", () => {
  test("renderDone shoots first tile cell-aligned", () => {
    const s = new Scheduler(GEO);
    s.dispatch({ type: "trigger" });
    expect(s.dispatch({ type: "renderDone", gen: 1, documentHeightPx: 1500 })).toEqual([
      { type: "shoot", gen: 1, tileIndex: 0, clip: { xCssPx: 0, yCssPx: 0, widthCssPx: 100, heightCssPx: 250 } },
    ]);
  });

  test("promotes when visible tiles are in", () => {
    const s = new Scheduler(GEO);
    s.dispatch({ type: "trigger" });
    s.dispatch({ type: "renderDone", gen: 1, documentHeightPx: 1500 });
    const b = s.dispatch({ type: "tileReady", gen: 1, tileIndex: 0 });
    expect(has(b, "deleteGen")).toBe(false);
    expect(shoots(b)).toEqual([1]);
    expect(s.viewState().displayGen).toBe(1);
    expect(shown(s).resident.has(0)).toBe(true);
    expect(newDisplayedGen1().viewState().phase).toBe("ready");
  });
});

describe("generation switch", () => {
  test("deletes old after placing new and clamps scroll", () => {
    const s = newDisplayedGen1();
    s.dispatch({ type: "key", delta: { kind: "bottom" } });
    expect<number>(s.viewState().scrollPx).toBe(1000);
    s.dispatch({ type: "trigger" });
    expect(shoots(s.dispatch({ type: "renderDone", gen: 2, documentHeightPx: 500 }))).toEqual([0]);
    const p = s.dispatch({ type: "tileReady", gen: 2, tileIndex: 0 });
    expect(p.findIndex((a) => a.type === "redraw")).toBeLessThan(p.findIndex((a) => a.type === "deleteGen"));
    const del = p.find((a): a is Action & { type: "deleteGen" } => a.type === "deleteGen");
    expect(del!.imageIds.slice().sort()).toEqual([imageId(1, 0), imageId(1, 1), imageId(1, 2)].sort());
    expect(s.viewState().displayGen).toBe(2);
    expect<number>(s.viewState().scrollPx).toBe(0);
  });

});

describe("trigger coalescing", () => {
  test("coalesced triggers start one gen after settle", () => {
    const s = new Scheduler(GEO);
    s.dispatch({ type: "trigger" });
    expect(s.dispatch({ type: "trigger" })).toEqual([]);
    expect(s.dispatch({ type: "trigger" })).toEqual([]);
    const next = s.dispatch({ type: "renderDone", gen: 1, documentHeightPx: 1500 });
    expect(shoots(next)).toEqual([]);
    expect(next.filter((a) => a.type === "render")).toEqual([{ type: "render", gen: 2 }]);
  });

  test("superseded unpromoted gen frees its tiles", () => {
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
  test("keeps old display then commits", () => {
    const s = new Scheduler(GEO);
    s.dispatch({ type: "trigger" });
    s.dispatch({ type: "renderDone", gen: 1, documentHeightPx: 1500 });
    s.dispatch({ type: "tileReady", gen: 1, tileIndex: 0 });
    const k = s.dispatch({ type: "key", delta: { kind: "bottom" } });
    expect(has(k, "redraw")).toBe(true);
    expect<number>(s.viewState().scrollPx).toBe(0);
    expect<number | null>(s.viewState().pendingScrollPx).toBe(1000);
    const vs = shown(s);
    expect(visibleTiles(vs.pendingScrollPx!, 50, 10, vs.tiles).map((p) => p.tileIndex)).toContain(2);
    expect(vs.resident.has(2)).toBe(false);
    expect(shoots(s.dispatch({ type: "tileReady", gen: 1, tileIndex: 1 }))).toEqual([2]);
    const after = s.dispatch({ type: "tileReady", gen: 1, tileIndex: 2 });
    expect(has(after, "redraw")).toBe(true);
    expect(shown(s).resident.has(2)).toBe(true);
    expect<number>(s.viewState().scrollPx).toBe(1000);
  });
});

describe("same-generation stall", () => {
  test("abandoning move keeps display without releasing", () => {
    const s = new Scheduler({ ...GEO, maxResident: 1, maxTotalResident: 1 });
    s.dispatch({ type: "trigger" });
    s.dispatch({ type: "renderDone", gen: 1, documentHeightPx: 5000 });
    s.dispatch({ type: "tileReady", gen: 1, tileIndex: 0 });
    const k = s.dispatch({ type: "key", delta: { kind: "bottom" } });
    expect(s.viewState().displayGen).toBe(1);
    expect<number>(s.viewState().scrollPx).toBe(0);
    expect(s.viewState().failure).toBe(true);
    expect(k.some((a) => a.type === "releaseGen" || a.type === "deleteGen")).toBe(false);
    expect(shown(s).resident.has(0)).toBe(true);
  });
});

describe("scroll vs update failure", () => {
  test("refetch failure clears on move, update failure survives scroll", () => {
    const tight: Geometry = { ...GEO, maxResident: 2, maxTotalResident: 4 };
    const s = new Scheduler(tight);
    s.dispatch({ type: "trigger" });
    drain(s, s.dispatch({ type: "renderDone", gen: 1, documentHeightPx: 5000 }), 1);
    s.dispatch({ type: "key", delta: { kind: "bottom" } });
    expect<number | null>(s.viewState().pendingScrollPx).not.toBe(null);
    s.dispatch({ type: "renderFailed", gen: 1 });
    expect(s.viewState().failure).toBe(true);
    s.dispatch({ type: "key", delta: { kind: "top" } });
    expect(s.viewState().failure).toBe(false);
    const u = newDisplayedGen1();
    u.dispatch({ type: "trigger" });
    u.dispatch({ type: "renderFailed", gen: 2 });
    u.dispatch({ type: "key", delta: { kind: "lines", n: 1 } });
    expect(u.viewState().failure).toBe(true);
  });
});

describe("scrolling when downscaled", () => {
  const REDUCED: Geometry = {
    rows: 65, cols: 216, cellHpx: 31, imgWidthPx: 1512, viewportWidthCssPx: 1512, renderScale: 1,
    tileHeightPx: alignedTileHeightPx(31, 64), exceedsFrameLimit: false, exceedsStorage: false, maxResident: 64, maxTotalResident: 128,
  };

  test("lines round-trip on unit multiples", () => {
    const s = displayedWith(REDUCED, 100000);
    for (let i = 0; i < 3; i++) {
      const before = s.viewState().scrollPx;
      s.dispatch({ type: "key", delta: { kind: "lines", n: 1 } });
      expect(s.viewState().scrollPx).toBeGreaterThan(before);
      s.dispatch({ type: "key", delta: { kind: "lines", n: -1 } });
      expect<number>(s.viewState().scrollPx).toBe(before);
    }
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
  test("mid-run resize discards gen and frees orphans", () => {
    const s = new Scheduler(GEO);
    s.dispatch({ type: "trigger" });
    s.dispatch({ type: "renderDone", gen: 1, documentHeightPx: 1500 });
    const bigger: Geometry = { ...GEO, rows: 61, cellHpx: 12, tileHeightPx: alignedTileHeightPx(12, 60) };
    expect(s.dispatch({ type: "resize", geometry: bigger })).toEqual([{ type: "redraw" }]);
    expect(s.viewState().displayGen).toBe(null);
    const back = s.dispatch({ type: "tileReady", gen: 1, tileIndex: 0 });
    expect(back.filter((a) => a.type === "deleteGen")).toEqual([{ type: "deleteGen", imageIds: [imageId(1, 0)] }]);
    expect(back.filter((a) => a.type === "render")).toEqual([{ type: "render", gen: 2 }]);
    expect(s.dispatch({ type: "tileReady", gen: 1, tileIndex: 5 })).toEqual([
      { type: "deleteGen", imageIds: [imageId(1, 5)] },
    ]);
    expect(s.viewState().geometry.cellHpx).toBe(12);
  });

  test("displayed resize frees all, same geometry keeps", () => {
    const s = newDisplayedGen1();
    const r = s.dispatch({ type: "resize", geometry: { ...GEO, rows: 41 } });
    const del = r.find((a): a is Action & { type: "deleteGen" } => a.type === "deleteGen");
    expect(del!.imageIds.slice().sort()).toEqual([imageId(1, 0), imageId(1, 1), imageId(1, 2)].sort());
    expect(has(r, "render")).toBe(true);
    const t = newDisplayedGen1();
    expect(t.dispatch({ type: "resize", geometry: { ...GEO } })).toEqual([{ type: "redraw" }]);
    expect(shown(t).resident.size).toBe(3);
  });
});

describe("scrolling during an unpromoted pipeline", () => {
  test("rebuilt order needs only visible tiles", () => {
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
  test("folds pipeline and coalesced trigger reruns", () => {
    const s = newDisplayedGen1();
    s.dispatch({ type: "trigger" });
    const f = s.dispatch({ type: "renderFailed", gen: 2 });
    expect(has(f, "redraw")).toBe(true);
    expect(has(f, "render")).toBe(false);
    expect(s.viewState().displayGen).toBe(1);
    expect(s.dispatch({ type: "trigger" }).filter((a) => a.type === "render")).toEqual([{ type: "render", gen: 3 }]);
    const t = newDisplayedGen1();
    t.dispatch({ type: "trigger" });
    t.dispatch({ type: "trigger" });
    expect(t.dispatch({ type: "renderFailed", gen: 2 }).filter((a) => a.type === "render" )).toEqual([{ type: "render", gen: 3 }]);
  });

  test("unpromoted frees images, promoted keeps them", () => {
    const s = newDisplayedGen1();
    s.dispatch({ type: "key", delta: { kind: "lines", n: 10 } });
    s.dispatch({ type: "trigger" });
    s.dispatch({ type: "renderDone", gen: 2, documentHeightPx: 1500 });
    s.dispatch({ type: "tileReady", gen: 2, tileIndex: 0 });
    expect(s.viewState().displayGen).toBe(1);
    expect(s.dispatch({ type: "renderFailed", gen: 2 }).filter((a) => a.type === "deleteGen")).toEqual([
      { type: "deleteGen", imageIds: [imageId(2, 0)] },
    ]);
    const u = new Scheduler(GEO);
    u.dispatch({ type: "trigger" });
    u.dispatch({ type: "renderDone", gen: 1, documentHeightPx: 1500 });
    u.dispatch({ type: "tileReady", gen: 1, tileIndex: 0 });
    const f = u.dispatch({ type: "renderFailed", gen: 1 });
    expect(has(f, "deleteGen")).toBe(false);
    expect(shown(u).resident.has(0)).toBe(true);
    expect(u.viewState().phase).toBe("ready");
    u.dispatch({ type: "key", delta: { kind: "bottom" } });
    expect(u.dispatch({ type: "trigger" }).filter((a) => a.type === "render")).toEqual([{ type: "render", gen: 2 }]);
  });

  test("first failure flags, update clears on success", () => {
    const s = new Scheduler(GEO);
    s.dispatch({ type: "trigger" });
    s.dispatch({ type: "renderFailed", gen: 1 });
    expect(s.viewState().displayGen).toBe(null);
    expect(s.viewState().failure).toBe(true);
    const u = newDisplayedGen1();
    u.dispatch({ type: "trigger" });
    u.dispatch({ type: "renderFailed", gen: 2 });
    expect(u.viewState().failure).toBe(true);
    u.dispatch({ type: "trigger" });
    drain(u, u.dispatch({ type: "renderDone", gen: 3, documentHeightPx: 1500 }), 3);
    expect(u.viewState().displayGen).toBe(3);
    expect(u.viewState().failure).toBe(false);
  });
});

describe("resident tile budget", () => {
  const SMALL: Geometry = { ...GEO, maxResident: 3 };

  test("scroll far evicts after redraw, visible never freed", () => {
    const s = displayedWith(SMALL, 5000);
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
    const vs = shown(s);
    for (const t of visibleTiles(vs.scrollPx, 50, 10, vs.tiles).map((p) => p.tileIndex)) expect(vs.resident.has(t)).toBe(true);
  });

  test("commit shrinks queue to steady budget without reshoot", () => {
    const s = displayedWith({ ...GEO, maxResident: 3, maxTotalResident: 4 }, 5000);
    let acts = s.dispatch({ type: "key", delta: { kind: "bottom" } });
    for (let i = 0; i < 20; i++) {
      const sh = shoots(acts);
      if (!sh.length) break;
      acts = s.dispatch({ type: "tileReady", gen: 1, tileIndex: sh[0]! });
    }
    expect([...shown(s).resident].sort((a, b) => a - b)).toEqual([7, 8, 9]);
    expect(shoots(s.dispatch({ type: "key", delta: { kind: "bottom" } }))).toEqual([]);
  });

  test("prefetch orders delete before shoot", () => {
    const s = new Scheduler({ ...GEO, maxResident: 2 });
    s.dispatch({ type: "trigger" });
    s.dispatch({ type: "renderDone", gen: 1, documentHeightPx: 1500 });
    s.dispatch({ type: "tileReady", gen: 1, tileIndex: 0 });
    s.dispatch({ type: "tileReady", gen: 1, tileIndex: 1 });
    expect(shoots(s.dispatch({ type: "key", delta: { kind: "halfpage", dir: 1 } }))).toEqual([]);
    const actions = s.dispatch({ type: "key", delta: { kind: "halfpage", dir: 1 } });
    expect(actions.findIndex((a) => a.type === "redraw")).toBeLessThan(actions.findIndex((a) => a.type === "deleteGen"));
    expect(actions.findIndex((a) => a.type === "deleteGen")).toBeLessThan(actions.findIndex((a) => a.type === "shoot"));
    expect(shoots(actions)).toEqual([2]);
  });

  test("save yields to new gen, late capture is kept", () => {
    const s = displayedWith(SMALL, 5000);
    s.dispatch({ type: "key", delta: { kind: "bottom" } });
    expect(s.dispatch({ type: "trigger" }).filter((a) => a.type === "render")).toEqual([{ type: "render", gen: 2 }]);
    const t = displayedWith(SMALL, 5000);
    const inFlight = shoots(t.dispatch({ type: "key", delta: { kind: "bottom" } }))[0]!;
    t.dispatch({ type: "trigger" });
    const late = t.dispatch({ type: "tileReady", gen: 1, tileIndex: inFlight });
    expect(late.some((a) => a.type === "deleteGen" && a.imageIds.includes(imageId(1, inFlight)))).toBe(false);
    expect(shown(t).resident.has(inFlight)).toBe(true);
  });
});

describe("cross-generation storage", () => {
  const TIGHT: Geometry = { ...GEO, maxResident: 3, maxTotalResident: 4 };
  const LOOSE: Geometry = { ...GEO, maxResident: 3, maxTotalResident: 128 };

  interface UpdateRecord { prePromotionTrims: number[]; promotionDeletes: number[]; prePromotionShoots: number[]; }

  function runStraddledUpdate(geo: Geometry): UpdateRecord {
    const s = new Scheduler(geo);
    s.dispatch({ type: "trigger" });
    drain(s, s.dispatch({ type: "renderDone", gen: 1, documentHeightPx: 5000 }), 1);
    s.dispatch({ type: "key", delta: { kind: "lines", n: 10 } });
    const atScroll = shown(s);
    const visibleOld = new Set(visibleTiles(atScroll.scrollPx, 50, 10, atScroll.tiles).map((p) => p.tileIndex));
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
            else { expect(visibleOld.has(idx)).toBe(false); rec.prePromotionTrims.push(id); }
            oldAlive.delete(idx);
          } else newAlive.delete(idx);
        }
      }
      for (const a of batch) {
        if (a.type !== "shoot" || a.gen !== 2) continue;
        if (promotionBatch || promoted) expect(newAlive.size + 1).toBeLessThanOrEqual(geo.maxResident);
        else { expect(visibleOld.has(a.tileIndex)).toBe(true); expect(oldAlive.size + newAlive.size + 1).toBeLessThanOrEqual(geo.maxTotalResident); rec.prePromotionShoots.push(a.tileIndex); }
        newAlive.add(a.tileIndex);
      }
      if (s.viewState().displayGen === 2) promoted = true;
    };
    s.dispatch({ type: "trigger" });
    let acts = s.dispatch({ type: "renderDone", gen: 2, documentHeightPx: 5000 });
    applyBatch(acts);
    for (let i = 0; i < 20 && s.viewState().phase === "rendering"; i++) {
      const pending: number[] = [];
      for (const a of acts) if (a.type === "shoot" && a.gen === 2) pending.push(a.tileIndex);
      acts = s.dispatch({ type: "tileReady", gen: 2, tileIndex: pending[pending.length - 1]! });
      applyBatch(acts);
    }
    expect(promoted).toBe(true);
    expect(oldAlive.size).toBe(0);
    return rec;
  }

  test("tight trims read-ahead before new transfers", () => {
    const rec = runStraddledUpdate(TIGHT);
    expect(rec.prePromotionShoots).toEqual([0, 1]);
    expect(rec.prePromotionTrims).toEqual([imageId(1, 2)]);
    expect(rec.promotionDeletes.slice().sort((a, b) => a - b)).toEqual([imageId(1, 0), imageId(1, 1)].sort((a, b) => a - b));
  });

  test("loose performs no pre-promotion trim", () => {
    const rec = runStraddledUpdate(LOOSE);
    expect(rec.prePromotionShoots).toEqual([0, 1]);
    expect(rec.prePromotionTrims).toEqual([]);
    expect(rec.promotionDeletes.slice().sort((a, b) => a - b)).toEqual([imageId(1, 0), imageId(1, 1), imageId(1, 2)].sort((a, b) => a - b));
  });
});

describe("storage overflow single-generation mode", () => {
  const OVERFLOW: Geometry = { ...GEO, maxResident: 3, maxTotalResident: 3, exceedsFrameLimit: false, exceedsStorage: true };

  test("never transfers beyond budget, dropping old display first", () => {
    const s = displayedWith(OVERFLOW, 5000);
    s.dispatch({ type: "key", delta: { kind: "lines", n: 10 } });
    const atScroll = shown(s);
    expect(visibleTiles(atScroll.scrollPx, 50, 10, atScroll.tiles).map((p) => p.tileIndex).sort()).toEqual([0, 1]);
    s.dispatch({ type: "trigger" });
    let acts = s.dispatch({ type: "renderDone", gen: 2, documentHeightPx: 5000 });
    let liveOld = new Set<number>(shown(s).resident);
    const liveNew = new Set<number>();
    let prePromotionRelease = false;
    let sawNullBeforeDisplay = false;
    let promoted = false;
    for (let i = 0; i < 20 && s.viewState().phase === "rendering"; i++) {
      for (const a of acts) {
        if (a.type === "deleteGen") for (const id of a.imageIds) (Math.floor(id / IMAGE_ID_GENERATION_STRIDE) === 1 ? liveOld : liveNew).delete(id % IMAGE_ID_GENERATION_STRIDE);
        if (a.type === "releaseGen" && a.gen === 1 && !promoted) prePromotionRelease = true;
        if (a.type === "shoot" && a.gen === 2) {
          expect(liveOld.size + liveNew.size + 1).toBeLessThanOrEqual(OVERFLOW.maxTotalResident);
          expect(liveNew.size + 1).toBeLessThanOrEqual(OVERFLOW.maxResident);
          liveNew.add(a.tileIndex);
        }
      }
      const pending = acts.filter((a): a is Action & { type: "shoot" } => a.type === "shoot" && a.gen === 2);
      if (!pending.length) break;
      acts = s.dispatch({ type: "tileReady", gen: 2, tileIndex: pending[pending.length - 1]!.tileIndex });
      if (s.viewState().displayGen === 2) promoted = true;
      else if (s.viewState().displayGen === null) sawNullBeforeDisplay = true;
      expect(liveOld.size + liveNew.size).toBeLessThanOrEqual(OVERFLOW.maxTotalResident);
    }
    expect(s.viewState().displayGen).toBe(2);
    expect(prePromotionRelease).toBe(true);
    expect(sawNullBeforeDisplay).toBe(true);
  });

  test("promotion and failure release correctly", () => {
    const s = displayedWith(OVERFLOW, 5000);
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
    const t = displayedWith(OVERFLOW, 5000);
    t.dispatch({ type: "trigger" });
    const f = t.dispatch({ type: "renderFailed", gen: 2 });
    expect(f.some((a) => a.type === "releaseGen" && a.gen === 2)).toBe(true);
    expect(f.some((a) => a.type === "releaseGen" && a.gen === 1)).toBe(false);
  });
});

describe("capped settle", () => {
  const cell = { cellHpx: 31, cellWpx: 14 };
  const relayed = detectGraphicsLimits({ HERDR_ENV: "1" });
  const geo400 = resolveGeometry({ cols: 400, rows: 400 }, cell, relayed);
  const geo80 = resolveGeometry({ cols: 80, rows: 24 }, cell, relayed);

  test("undisplayable settles, retry and resize recover", () => {
    expect(geo400.exceedsStorage).toBe(true);
    const s = new Scheduler(geo400);
    s.dispatch({ type: "trigger" });
    let acts = s.dispatch({ type: "renderDone", gen: 1, documentHeightPx: 399 * 31 });
    let shots = 0;
    for (let i = 0; i < 300; i++) {
      const sh = shoots(acts);
      if (!sh.length) break;
      acts = s.dispatch({ type: "tileReady", gen: 1, tileIndex: sh[0]! });
      shots++;
    }
    expect(shots).toBeGreaterThan(0);
    expect(s.viewState().displayGen).toBe(null);
    expect(s.viewState().phase).toBe("ready");
    expect(shots).toBeLessThan(201);
    expect(s.dispatch({ type: "trigger" }).some((a) => a.type === "render")).toBe(true);
    const t = new Scheduler(geo400);
    t.dispatch({ type: "trigger" });
    drain(t, t.dispatch({ type: "renderDone", gen: 1, documentHeightPx: 399 * 31 }), 1, 300);
    const r = t.dispatch({ type: "resize", geometry: geo80 });
    expect(r.some((a) => a.type === "render")).toBe(true);
    expect(t.viewState().geometry.cols).toBe(80);
  });
});
