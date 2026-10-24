import { describe, expect, test } from "bun:test";
import { renderFrame } from "./term.ts";
import { alignedTileHeightPx, detectGraphicsLimits, resolveGeometry, type Geometry } from "./geometry.ts";
import { IMAGE_ID_GENERATION_STRIDE, imageId } from "./kitty.ts";
import { Scheduler, type Action, type ScrollDelta } from "./scheduler.ts";
import { GEO } from "./test-geometry.ts";

type Shoot = Extract<Action, { type: "shoot" }>;

/**
 * Plays the scheduler's actions against a model of the terminal and fails on
 * anything the user would see: a blank tile, a flash, a wasted or overflowing transfer.
 */
class Session {
  readonly scheduler: Scheduler;
  readonly released: number[] = [];
  screen = "";
  private readonly live = new Set<number>();
  private placed = new Set<number>();
  private renders: number[] = [];
  private inFlight: Shoot[] = [];

  constructor(geometry: Geometry) {
    this.scheduler = new Scheduler(geometry);
  }

  get view() {
    return this.scheduler.viewState();
  }

  send(event: Parameters<Scheduler["dispatch"]>[0]): Action[] {
    const actions = this.scheduler.dispatch(event);
    for (const action of actions) this.apply(action);
    this.expectWithinBudget();
    return actions;
  }

  save(): Action[] {
    return this.send({ type: "trigger" });
  }

  key(delta: ScrollDelta): Action[] {
    return this.send({ type: "key", delta });
  }

  rendered(documentHeightPx: number): Action[] {
    return this.send({ type: "renderDone", gen: this.renders.shift()!, documentHeightPx });
  }

  renderFails(): Action[] {
    return this.send({ type: "renderFailed", gen: this.renders.shift()! });
  }

  shootFails(): Action[] {
    const shot = this.inFlight.shift()!;
    return this.send({ type: "renderFailed", gen: shot.gen });
  }

  deliver(): Action[] {
    const shot = this.inFlight.shift()!;
    this.live.add(imageId(shot.gen, shot.tileIndex));
    return this.send({ type: "tileReady", gen: shot.gen, tileIndex: shot.tileIndex });
  }

  deliverAll(): void {
    for (let i = 0; i < 500 && this.inFlight.length > 0; i++) this.deliver();
    expect(this.inFlight).toEqual([]);
  }

  pendingRenders(): number[] {
    return [...this.renders];
  }

  pendingShoots(): number[] {
    return this.inFlight.map((s) => s.tileIndex);
  }

  liveTiles(gen: number): number[] {
    return [...this.live]
      .filter((id) => Math.floor(id / IMAGE_ID_GENERATION_STRIDE) === gen)
      .map((id) => id % IMAGE_ID_GENERATION_STRIDE)
      .sort((a, b) => a - b);
  }

  private apply(action: Action): void {
    switch (action.type) {
      case "redraw": {
        const frame = renderFrame(this.view, "a.md", []);
        this.screen = frame.escape;
        this.placed = new Set(frame.placements);
        for (const id of this.placed) expect(this.live.has(id)).toBe(true);
        break;
      }
      case "deleteGen":
        for (const id of action.imageIds) {
          // Deleting a placed image blanks it until the next redraw, unless nothing stays shown anyway.
          if (this.view.displayGen) expect(this.placed.has(id)).toBe(false);
          this.live.delete(id);
        }
        break;
      case "shoot": {
        const id = imageId(action.gen, action.tileIndex);
        expect(this.live.has(id)).toBe(false);
        expect(this.inFlight.some((s) => imageId(s.gen, s.tileIndex) === id)).toBe(false);
        this.inFlight.push(action);
        this.expectWithinBudget();
        break;
      }
      case "render":
        this.renders.push(action.gen);
        break;
      case "releaseGen":
        this.released.push(action.gen);
        break;
    }
  }

  // Only a pending scroll or a render may hold more than the steady budget.
  private expectWithinBudget(): void {
    const { geometry, phase, pendingScrollPx } = this.view;
    const budget = phase === "ready" && pendingScrollPx === null ? geometry.maxResident : geometry.maxTotalResident;
    expect(this.live.size + this.inFlight.length).toBeLessThanOrEqual(budget);
  }
}

/** GEO shows 50 rows of 10px cells; tiles are 500px, so a 1500px document has three. */
function displayed(geometry: Geometry, documentHeightPx: number): Session {
  const s = new Session(geometry);
  s.save();
  s.rendered(documentHeightPx);
  s.deliverAll();
  expect(s.view).toMatchObject({ displayGen: { gen: 1 }, failure: false });
  return s;
}

const BOTTOM: ScrollDelta = { kind: "bottom" };

describe("rendering", () => {
  test("saves during a render coalesce into one rerun", () => {
    const s = new Session(GEO);
    s.save();
    s.save();
    s.save();
    expect(s.pendingRenders()).toEqual([1]);
    s.rendered(1500);
    expect(s.pendingRenders()).toEqual([2]);
    expect(s.pendingShoots()).toEqual([]);
    s.rendered(1500);
    s.deliverAll();
    expect(s.view.displayGen?.gen).toBe(2);
  });

  test("a document that cannot be shown within storage settles instead of retrying forever", () => {
    const g = resolveGeometry({ cols: 400, rows: 400 }, { cellHpx: 31, cellWpx: 14 }, detectGraphicsLimits({ HERDR_ENV: "1" }));
    expect(g.exceedsStorage).toBe(true);
    const s = new Session(g);
    s.save();
    s.rendered(399 * 31);
    s.deliverAll();
    expect(s.view).toMatchObject({ displayGen: null, phase: "ready" });
    s.save();
    expect(s.pendingRenders()).toEqual([2]);
  });
});

describe("failures", () => {
  test("a failed update keeps the display and stays reported until an update succeeds", () => {
    const s = displayed(GEO, 1500);
    s.key({ kind: "lines", n: 10 });
    s.save();
    s.rendered(1500);
    s.deliver();
    s.shootFails();
    expect(s.view.displayGen?.gen).toBe(1);
    expect(s.screen).toContain("update failed");
    expect(s.liveTiles(2)).toEqual([]);
    expect(s.released).toEqual([2]);
    s.key({ kind: "lines", n: 1 });
    expect(s.screen).toContain("update failed");

    s.save();
    s.rendered(1500);
    s.deliverAll();
    expect(s.view.displayGen?.gen).toBe(3);
    expect(s.screen).not.toContain("failed");
  });

  test("a save during a failing update reruns it; without one nothing restarts", () => {
    const rerun = displayed(GEO, 1500);
    rerun.save();
    rerun.save();
    rerun.renderFails();
    expect(rerun.pendingRenders()).toEqual([3]);

    const idle = displayed(GEO, 1500);
    idle.save();
    idle.renderFails();
    expect(idle.pendingRenders()).toEqual([]);
    idle.save();
    expect(idle.pendingRenders()).toEqual([3]);
  });

  test("a failed backfill keeps the tiles already shown and accepts the next save", () => {
    const s = new Session(GEO);
    s.save();
    s.rendered(1500);
    s.deliver();
    s.shootFails();
    expect(s.view).toMatchObject({ displayGen: { gen: 1 }, phase: "ready" });
    expect(s.liveTiles(1)).toEqual([0]);
    s.save();
    expect(s.pendingRenders()).toEqual([2]);
  });

  test("a failed scroll fetch is reported until the next move", () => {
    const s = displayed({ ...GEO, maxResident: 2, maxTotalResident: 4 }, 5000);
    s.key(BOTTOM);
    expect(s.view.pendingScrollPx).not.toBeNull();
    s.shootFails();
    expect(s.view).toMatchObject({ pendingScrollPx: null, scrollPx: 0 });
    expect(s.screen).toContain("update failed");
    s.key({ kind: "top" });
    expect(s.screen).not.toContain("failed");
  });
});

describe("scrolling", () => {
  test("a move the budget cannot hold is abandoned without dropping the display", () => {
    const s = new Session({ ...GEO, maxResident: 1, maxTotalResident: 1 });
    s.save();
    s.rendered(5000);
    s.deliver();
    s.key(BOTTOM);
    expect(s.view).toMatchObject({ displayGen: { gen: 1 }, scrollPx: 0 });
    expect(s.screen).toContain("update failed");
    expect(s.liveTiles(1)).toEqual([0]);
    expect(s.released).toEqual([]);
  });

  test("scrolling far stays within the resident budget and settles without refetching", () => {
    const s = displayed({ ...GEO, maxResident: 3, maxTotalResident: 4 }, 5000);
    s.key(BOTTOM);
    s.deliverAll();
    expect(s.view.scrollPx).toBe(4500);
    expect(s.liveTiles(1)).toEqual([7, 8, 9]);
    s.key(BOTTOM);
    expect(s.pendingShoots()).toEqual([]);
  });

  test("prefetching ahead frees the farthest tile before transferring", () => {
    const s = displayed({ ...GEO, maxResident: 2 }, 1500);
    s.key({ kind: "halfpage", dir: 1 });
    expect(s.pendingShoots()).toEqual([]);
    s.key({ kind: "halfpage", dir: 1 });
    expect(s.pendingShoots()).toEqual([2]);
    expect(s.liveTiles(1)).toEqual([1]);
  });

  test("a tile that arrives after a save still completes the scroll on the shown generation", () => {
    const s = displayed({ ...GEO, maxResident: 3 }, 5000);
    s.key(BOTTOM);
    s.save();
    expect(s.pendingRenders()).toEqual([2]);
    s.deliver();
    expect(s.view).toMatchObject({ displayGen: { gen: 1 }, scrollPx: 4500 });
    s.rendered(5000);
    s.deliverAll();
    expect(s.view).toMatchObject({ displayGen: { gen: 2 }, scrollPx: 4500 });
  });

  test("scrolling during an update fetches the newly visible tiles first", () => {
    const s = displayed(GEO, 1500);
    s.save();
    s.rendered(1500);
    s.key(BOTTOM);
    s.deliver();
    expect(s.pendingShoots()).toEqual([2]);
    s.deliver();
    expect(s.view).toMatchObject({ displayGen: { gen: 2 }, scrollPx: 1000 });
  });

  test("downscaled scrolling moves in two-cell steps and returns to where it started", () => {
    const reduced: Geometry = {
      ...GEO,
      rows: 65,
      cols: 216,
      cellHpx: 31,
      imgWidthPx: 1512,
      renderScale: 0.5,
      tileHeightPx: alignedTileHeightPx(31, 64),
    };
    const s = displayed(reduced, 100000);
    s.key({ kind: "lines", n: 1 });
    expect(s.view.scrollPx).toBe(62);
    s.key({ kind: "lines", n: -1 });
    expect(s.view.scrollPx).toBe(0);
  });
});

describe("resize", () => {
  test("a resize during a render restarts it with the new geometry and drops late tiles", () => {
    const s = new Session(GEO);
    s.save();
    s.rendered(1500);
    const bigger: Geometry = { ...GEO, rows: 61, cellHpx: 12, tileHeightPx: alignedTileHeightPx(12, 60) };
    expect(s.send({ type: "resize", geometry: bigger })).toEqual([{ type: "redraw" }]);
    expect(s.view).toMatchObject({ displayGen: null, geometry: { cellHpx: 12 } });
    s.deliver();
    expect(s.liveTiles(1)).toEqual([]);
    expect(s.pendingRenders()).toEqual([2]);
  });

  test("a tile of a released generation that lands during another render is deleted", () => {
    const tight: Geometry = { ...GEO, maxResident: 2, maxTotalResident: 4 };
    const s = displayed(tight, 5000);
    s.key(BOTTOM);
    expect(s.pendingShoots()).not.toEqual([]);
    s.save();
    s.send({ type: "resize", geometry: { ...tight, rows: 41 } });
    expect(s.released).toEqual([1]);
    s.deliver();
    expect(s.liveTiles(1)).toEqual([]);
  });

  test("a resize frees the shown generation and re-renders; the same size only redraws", () => {
    const s = displayed(GEO, 1500);
    s.send({ type: "resize", geometry: { ...GEO, rows: 41 } });
    expect(s.liveTiles(1)).toEqual([]);
    expect(s.pendingRenders()).toEqual([2]);

    const same = displayed(GEO, 1500);
    expect(same.send({ type: "resize", geometry: { ...GEO } })).toEqual([{ type: "redraw" }]);
    expect(same.liveTiles(1)).toEqual([0, 1, 2]);
  });
});

describe("storage across generations", () => {
  test("a shorter update trims read-ahead to fit beside the display and clamps the scroll", () => {
    const s = displayed({ ...GEO, maxResident: 3, maxTotalResident: 4 }, 5000);
    s.key(BOTTOM);
    s.deliverAll();
    expect(s.view.scrollPx).toBe(4500);
    s.save();
    s.rendered(900);
    s.deliverAll();
    expect(s.view).toMatchObject({ displayGen: { gen: 2 }, scrollPx: 400 });
    expect(s.liveTiles(1)).toEqual([]);
    expect(s.released).toEqual([1]);
  });

  test("when two generations cannot fit, the old display is dropped instead of overflowing", () => {
    const s = displayed({ ...GEO, maxResident: 3, maxTotalResident: 3, exceedsStorage: true }, 5000);
    s.key({ kind: "lines", n: 10 });
    s.save();
    s.rendered(5000);
    s.deliverAll();
    expect(s.view.displayGen?.gen).toBe(2);
    expect(s.released).toEqual([1]);
  });
});
