// Pure state machine for the concurrency model and generation bookkeeping (§4.6). No I/O.
//
// A reducer: dispatch(event) updates the state and returns "the actions to take next". main.ts only
// wires it to the I/O modules (chrome/term/kitty). State needed for display is read through
// viewState() (a read-only projection, not I/O).
//
// The four rules of §4.6:
//  1. At most one pipeline runs at a time (a non-null pipeGen means one is running)
//  2. Triggers (watch/resize) coalesce, keeping only the newest (the rerun flag)
//  3. Keys always act on the displayed generation displayGen (scrolling works mid-pipeline)
//  4. On a generation switch, scrollPx is clamped to the new document height and carried over

import {
  backfillOrder,
  clampScroll,
  computeTiles,
  contentRows,
  CSS_SCALE,
  maxScrollPx,
  NO_CONTENT,
  SCROLL_TOP,
  scrollUnitPx,
  visibleTiles,
  type ContentHeight,
  type ScrollPx,
  type Tile,
} from "./viewport.ts";
import { imageId } from "./kitty.ts";

export interface Geometry {
  /** Total terminal rows (the last one is the status bar). */
  rows: number;
  cols: number;
  /** Physical px height of one row (from CSI 16t). */
  cellHpx: number;
  /** Physical screenshot width = kitty's source rect w (pixels within the image). */
  imgWidthPx: number;
  /** Chrome's CSS viewport width. Fixes the font size and reflow (= screen width px / CSS_SCALE). */
  cssWidth: number;
  /**
   * The screenshot's deviceScaleFactor (§4.8). CSS_SCALE at 1:1. Geometries that would not fit
   * herdr's 32 MiB drop to 1, halving the image in both directions and letting kitty scale the
   * placement back up.
   */
  renderScale: number;
  /**
   * A geometry that exceeds herdr's relay limit even downscaled (§4.8). Nothing can be done on the
   * mdpx side, so this exists only to explain the blank screen in the status bar.
   */
  relayOverflow: boolean;
  /** How many tiles may stay resident in the terminal at once. Derived and justified in herdr.maxResidentTiles (§4.4). */
  maxResident: number;
}

export type ScrollDelta =
  | { kind: "lines"; n: number }
  | { kind: "halfpage"; dir: 1 | -1 }
  | { kind: "top" }
  | { kind: "bottom" };

export type SchedulerEvent =
  | { type: "trigger" }
  | { type: "resize"; geometry: Geometry }
  | { type: "key"; delta: ScrollDelta }
  | { type: "renderDone"; gen: number; docHpx: number }
  | { type: "renderFailed"; gen: number }
  | { type: "tileReady"; gen: number; tileIndex: number };

export interface Clip {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type Action =
  | { type: "render"; gen: number }
  | { type: "shoot"; gen: number; tileIndex: number; clip: Clip }
  | { type: "redraw" }
  | { type: "deleteGen"; imageIds: number[] };

type Phase = "rendering" | "ready";

interface ViewBase {
  geometry: Geometry;
  scrollPx: ScrollPx;
  phase: Phase;
}

/** No generation has been promoted yet (the first render is in flight). There is no body to place. */
export interface BlankView extends ViewBase {
  displayGen: null;
}

/** A generation is displayed. Everything below belongs **to that generation** and means nothing alone. */
export interface GenView extends ViewBase {
  displayGen: number;
  tiles: Tile[];
  /** Indices of tiles resident in the terminal. Visible regions that are not resident show "rendering…". */
  resident: ReadonlySet<number>;
  /** Whether the tile cap cut the tail off (§4.4's "truncated"). */
  truncated: boolean;
  contentHpx: ContentHeight;
}

/**
 * Discriminated on displayGen. Merging the two and giving the blank case an empty tile list, an
 * empty resident set, and contentHpx=0 would make "no generation to display" look exactly like
 * "displaying a generation whose body is 0 px tall", forcing every consumer to sort them out with a
 * null check (there were five such checks in frame.ts).
 */
export type ViewState = BlankView | GenView;

interface GenState {
  gen: number;
  tiles: Tile[];
  contentHpx: ContentHeight;
  /** Indices of tiles resident in the terminal (kept inside §4.4's budget). */
  resident: Set<number>;
  truncated: boolean;
  /** Marks a generation whose captures a resize invalidated. It is discarded and re-run on completion. */
  stale: boolean;
}

export class Scheduler {
  private geometry: Geometry;
  private scrollPx: ScrollPx = SCROLL_TOP;
  private genCounter = 0;
  private displayGen: GenState | null = null;
  private pipeGen: GenState | null = null;
  private shootInFlight = false;
  private shootQueue: number[] = [];
  private rerun = false;
  /** Merely re-capturing tiles of the displayed generation (§4.4), as opposed to building a new one. */
  private refetching = false;

  constructor(geometry: Geometry) {
    this.geometry = geometry;
  }

  private get contentRows(): number {
    return contentRows(this.geometry.rows);
  }

  dispatch(event: SchedulerEvent): Action[] {
    switch (event.type) {
      case "trigger":
        return this.onTrigger();
      case "resize":
        return this.onResize(event.geometry);
      case "key":
        return this.onKey(event.delta);
      case "renderDone":
        return this.onRenderDone(event.gen, event.docHpx);
      case "renderFailed":
        return this.onRenderFailed(event.gen);
      case "tileReady":
        return this.onTileReady(event.gen, event.tileIndex);
    }
  }

  viewState(): ViewState {
    const base: ViewBase = {
      geometry: this.geometry,
      scrollPx: this.scrollPx,
      // "rendering" means a new generation is being built. Merely re-capturing tiles that fell out
      // of residency does not count (pendingVisible picks those up as "rendering…")
      phase: this.pipeGen && !this.refetching ? "rendering" : "ready",
    };
    const g = this.displayGen;
    if (!g) return { ...base, displayGen: null };
    return {
      ...base,
      displayGen: g.gen,
      tiles: g.tiles,
      resident: g.resident,
      truncated: g.truncated,
      contentHpx: g.contentHpx,
    };
  }

  private onTrigger(): Action[] {
    // Re-capturing the displayed generation (§4.4) occupies the pipeline slot, but a new generation
    // recaptures everything anyway, so it yields. Deferring to rerun here would make a save wait on
    // images that are about to be thrown away
    if (this.pipeGen && !this.refetching) {
      this.rerun = true;
      return [];
    }
    return this.startPipeline();
  }

  private onResize(geometry: Geometry): Action[] {
    this.geometry = geometry;
    // The existing generation's tiles were captured at the old geometry and no longer match the
    // scale. Discard them, fall back to "rendering…", and re-render with the new reflow.
    // Transferred images of the discarded generation are freed from the terminal's storage (they are
    // assumed resident, so not freeing them leaks). When displayGen === pipeGen (mid-backfill),
    // abortStale deletes them all at once.
    const old = this.displayGen;
    this.displayGen = null;
    const actions: Action[] = [];
    if (old && old !== this.pipeGen) {
      const ids = this.residentIds(old);
      if (ids.length) actions.push({ type: "deleteGen", imageIds: ids });
    }
    if (this.pipeGen) {
      this.pipeGen.stale = true;
      this.rerun = true;
      actions.push({ type: "redraw" });
      return actions;
    }
    actions.push(...this.startPipeline());
    return actions;
  }

  private startPipeline(): Action[] {
    this.genCounter += 1;
    this.pipeGen = {
      gen: this.genCounter,
      tiles: [],
      contentHpx: NO_CONTENT,
      resident: new Set(),
      truncated: false,
      stale: false,
    };
    this.shootQueue = [];
    this.shootInFlight = false;
    this.rerun = false;
    this.refetching = false;
    return [{ type: "render", gen: this.genCounter }, { type: "redraw" }];
  }

  private onKey(delta: ScrollDelta): Action[] {
    if (!this.displayGen) return [];
    const { cellHpx, renderScale } = this.geometry;
    const contentHpx = this.displayGen.contentHpx;
    let px: number = this.scrollPx;
    // Every movement must be a multiple of the scroll unit. Adding anything else makes clampScroll's
    // snap land on a midpoint, so a round trip does not return to where it started and the position
    // drifts one way (§4.5)
    const unit = scrollUnitPx(cellHpx, renderScale);
    switch (delta.kind) {
      case "lines":
        px += delta.n * unit;
        break;
      case "halfpage": {
        const half = Math.max(1, Math.floor(this.contentRows / 2)) * cellHpx;
        px += delta.dir * Math.max(unit, Math.round(half / unit) * unit);
        break;
      }
      case "top":
        px = 0;
        break;
      case "bottom":
        px = maxScrollPx(contentHpx, this.contentRows, cellHpx, renderScale);
        break;
    }
    this.scrollPx = clampScroll(px, contentHpx, this.contentRows, cellHpx, renderScale);
    // If a generation is being captured, reorder the queue by proximity to the new scroll position
    // (§4.1). This includes a new generation that has not been promoted yet — skipping it would push
    // the promotion condition (the tiles visible at the new position) to the end of the capture
    // order and delay promotion until every tile is done
    const pg = this.pipeGen;
    if (pg && pg.tiles.length > 0) {
      const pgScroll =
        pg === this.displayGen
          ? this.scrollPx
          : clampScroll(this.scrollPx, pg.contentHpx, this.contentRows, cellHpx, renderScale);
      this.shootQueue = this.queueAround(pg, pgScroll);
      return [{ type: "redraw" }];
    }
    // Even after the pipeline folded, scrolling outside the resident set restarts capturing (§4.4).
    // The budget makes full residency impossible, so a jump far enough always lands here
    return [{ type: "redraw" }, ...this.refetchVisible()];
  }

  /**
   * Take as much of the capture order (§4.1's visible-first) as the residency budget allows.
   * Capturing beyond the budget would only mean freeing the image before it is ever placed.
   */
  private queueAround(g: GenState, scroll: ScrollPx): number[] {
    const order = backfillOrder(scroll, this.contentRows, this.geometry.cellHpx, g.tiles);
    return order.slice(0, this.geometry.maxResident);
  }

  private refetchVisible(): Action[] {
    const g = this.displayGen;
    if (!g || this.pipeGen || g.tiles.length === 0) return [];
    if (this.allVisibleResident(g, this.scrollPx)) return [];
    this.pipeGen = g; // no new generation; just re-capture this one's missing tiles
    this.refetching = true;
    this.shootQueue = this.queueAround(g, this.scrollPx);
    return this.drive();
  }

  private onRenderDone(gen: number, docHpx: number): Action[] {
    const g = this.pipeGen;
    if (!g || g.gen !== gen) return []; // a stale completion dropped by coalescing
    if (g.stale) return this.abortStale();

    const { tiles, truncated, contentHpx } = computeTiles(docHpx, this.geometry.cellHpx, this.contentRows);
    g.tiles = tiles;
    g.truncated = truncated;
    g.contentHpx = contentHpx;
    // Order visible-first for the scroll position this will be displayed at after promotion (§4.1)
    const { cellHpx, renderScale } = this.geometry;
    const promoScroll = clampScroll(this.scrollPx, contentHpx, this.contentRows, cellHpx, renderScale);
    this.shootQueue = this.queueAround(g, promoScroll);
    return this.drive();
  }

  private onRenderFailed(gen: number): Action[] {
    const g = this.pipeGen;
    if (!g || g.gen !== gen) return [];
    // Fold the failed generation's pipeline. Capturing cannot resume, so drop the capture queue too.
    // A failure during backfill (after renderDone) may already have transferred tiles:
    //  - not promoted: the current frame stays on screen, so free those images from the terminal (no leak).
    //  - promoted: they are on screen right now, so keep them (missing tiles read "rendering…" and
    //    are re-captured on the next trigger).
    const promoted = this.displayGen === g;
    this.pipeGen = null;
    this.shootQueue = [];
    this.shootInFlight = false;
    const actions: Action[] = [];
    if (!promoted) {
      const ids = this.residentIds(g);
      if (ids.length) actions.push({ type: "deleteGen", imageIds: ids });
    }
    actions.push({ type: "redraw" });
    if (this.rerun) actions.push(...this.startPipeline());
    return actions;
  }

  private onTileReady(gen: number, tileIndex: number): Action[] {
    const g = this.pipeGen;
    if (!g || g.gen !== gen) {
      // When a new generation started mid-recapture, a late capture still belongs to the generation
      // on screen right now, so use it. Deleting it here would punch a black hole in the display
      const shown = this.displayGen;
      if (shown && shown.gen === gen) {
        shown.resident.add(tileIndex);
        const freed = this.evictBeyondBudget(shown);
        const actions: Action[] = [{ type: "redraw" }];
        if (freed.length) actions.push({ type: "deleteGen", imageIds: freed });
        return actions;
      }
      // An in-flight capture of a discarded generation. Only the transfer completed, so free that
      // one image from the terminal
      return [{ type: "deleteGen", imageIds: [imageId(gen, tileIndex)] }];
    }
    this.shootInFlight = false;
    g.resident.add(tileIndex);
    if (g.stale) return this.abortStale();
    // Free anything over budget ourselves, farthest from the viewport first (why this is not left to
    // the terminal: herdr.maxResidentTiles)
    const freed = this.evictBeyondBudget(g);
    // On promotion, drive already returns a redraw first. Adding another would delete and re-place
    // the placements the first one made, so let that one do the work.
    const actions = this.drive();
    const withRedraw = actions[0]?.type === "redraw" ? actions : [{ type: "redraw" } as Action, ...actions];
    // Free after placing (deleting first would briefly drop placements that are still on screen)
    return freed.length ? [...withRedraw, { type: "deleteGen", imageIds: freed }] : withRedraw;
  }

  /**
   * If residency exceeds the budget, free tiles farthest from the viewport and return their image
   * ids (§4.4). Visible tiles are never dropped — dropping one punches a black hole in what is on
   * screen right now.
   */
  private evictBeyondBudget(g: GenState): number[] {
    const budget = this.geometry.maxResident;
    if (g.resident.size <= budget) return [];
    const scroll = g === this.displayGen ? this.scrollPx : SCROLL_TOP;
    const visible = new Set(
      visibleTiles(scroll, this.contentRows, this.geometry.cellHpx, g.tiles).map((p) => p.tileIndex),
    );
    const order = backfillOrder(scroll, this.contentRows, this.geometry.cellHpx, g.tiles);
    const freed: number[] = [];
    for (let i = order.length - 1; i >= 0 && g.resident.size > budget; i--) {
      const t = order[i]!;
      if (!g.resident.has(t) || visible.has(t)) continue;
      g.resident.delete(t);
      freed.push(imageId(g.gen, t));
    }
    return freed;
  }

  private abortStale(): Action[] {
    // stale is only ever set together with rerun (onResize). Free the transferred images and re-run
    // at the newest geometry. startPipeline replaces the generation state (pipeGen / shootQueue /
    // shootInFlight) wholesale.
    const ids = this.residentIds(this.pipeGen!);
    const actions: Action[] = ids.length ? [{ type: "deleteGen", imageIds: ids }] : [];
    actions.push(...this.startPipeline());
    return actions;
  }

  /**
   * Advance the pipeline one step: promote to the new generation once its visible tiles are in
   * (§4.6 rule 4), capture the next tile if the capture slot is free, or finish and consume the
   * pending rerun once everything is captured.
   */
  private drive(): Action[] {
    const g = this.pipeGen;
    if (!g) return [];
    const { cellHpx, renderScale } = this.geometry;
    const actions: Action[] = [];

    if (this.displayGen !== g) {
      const promoScroll = clampScroll(this.scrollPx, g.contentHpx, this.contentRows, cellHpx, renderScale);
      if (this.allVisibleResident(g, promoScroll)) {
        const old = this.displayGen;
        this.scrollPx = promoScroll; // rule 4: clamp to the new document height and carry over
        this.displayGen = g;
        actions.push({ type: "redraw" }); // place the new generation's visible tiles first…
        if (old) {
          const ids = this.residentIds(old);
          if (ids.length) actions.push({ type: "deleteGen", imageIds: ids }); // …then delete the old generation (§4.4)
        }
      }
    }

    if (!this.shootInFlight) {
      const next = this.nextShoot();
      if (next !== null) {
        this.shootInFlight = true;
        actions.push(this.shootAction(g, next));
      } else if (this.displayGen === g) {
        this.pipeGen = null;
        this.refetching = false;
        if (this.rerun) actions.push(...this.startPipeline());
      }
    }
    return actions;
  }

  private residentIds(g: GenState): number[] {
    return Array.from(g.resident, (i) => imageId(g.gen, i));
  }

  private nextShoot(): number | null {
    const g = this.pipeGen!;
    while (this.shootQueue.length) {
      const i = this.shootQueue.shift()!;
      if (!g.resident.has(i)) return i;
    }
    return null;
  }

  private shootAction(g: GenState, tileIndex: number): Action {
    const tile = g.tiles[tileIndex]!;
    const { cssWidth } = this.geometry;
    return {
      type: "shoot",
      gen: g.gen,
      tileIndex,
      // Tile boundaries are 2*cellHpx aligned, so physical/CSS_SCALE is an integer CSS px (§4.3, viewport.CSS_SCALE)
      clip: { x: 0, y: tile.y / CSS_SCALE, width: cssWidth, height: tile.height / CSS_SCALE },
    };
  }

  private allVisibleResident(g: GenState, scroll: ScrollPx): boolean {
    const vis = visibleTiles(scroll, this.contentRows, this.geometry.cellHpx, g.tiles);
    return vis.every((p) => g.resident.has(p.tileIndex));
  }
}
