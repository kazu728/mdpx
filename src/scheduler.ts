import {
  backfillOrder,
  clampScroll,
  computeTiles,
  contentRows,
  CSS_SCALE,
  maxScrollPx,
  NO_CONTENT_HEIGHT,
  SCROLL_TOP,
  scrollUnitPx,
  visibleTiles,
  type ContentHeightPx,
  type ScrollAlignedPx,
  type ScrollDirection,
  type Tile,
} from "./viewport.ts";
import { imageId } from "./kitty.ts";
import type { Clip, Geometry } from "./geometry.ts";

export type ScrollDelta =
  | { kind: "lines"; n: number }
  | { kind: "halfpage"; dir: 1 | -1 }
  | { kind: "top" }
  | { kind: "bottom" };

export type SchedulerEvent =
  | { type: "trigger" }
  | { type: "resize"; geometry: Geometry }
  | { type: "key"; delta: ScrollDelta }
  | { type: "renderDone"; gen: number; documentHeightPx: number }
  | { type: "renderFailed"; gen: number }
  | { type: "tileReady"; gen: number; tileIndex: number };

export type Action =
  | { type: "render"; gen: number }
  | { type: "shoot"; gen: number; tileIndex: number; clip: Clip }
  | { type: "redraw" }
  | { type: "deleteGen"; imageIds: number[] }
  | { type: "releaseGen"; gen: number }
  | { type: "scrollCommitted"; jumpToEnd: boolean };

type Phase = "rendering" | "ready";

interface ViewBase {
  geometry: Geometry;
  scrollPx: ScrollAlignedPx;
  phase: Phase;
  /** The last render failed and no newer generation has displayed since. */
  failure: boolean;
  /** Latest requested scroll while the display stays behind; null once settled. */
  pendingScrollPx: ScrollAlignedPx | null;
}

export interface BlankView extends ViewBase {
  displayGen: null;
}

export interface GenView extends ViewBase {
  displayGen: number;
  tiles: Tile[];
  resident: ReadonlySet<number>;
  truncated: boolean;
  contentHeightPx: ContentHeightPx;
}

/** Distinguishes no displayed generation from a displayed empty document. */
export type ViewState = BlankView | GenView;

interface GenState {
  gen: number;
  tiles: Tile[];
  contentHeightPx: ContentHeightPx;
  resident: Set<number>;
  truncated: boolean;
  invalidatedByResize: boolean;
}

/** Resize events can repeat the current dimensions; only a real change invalidates captures. */
function sameGeometry(a: Geometry, b: Geometry): boolean {
  return (
    a.rows === b.rows &&
    a.cols === b.cols &&
    a.cellHpx === b.cellHpx &&
    a.imgWidthPx === b.imgWidthPx &&
    a.viewportWidthCssPx === b.viewportWidthCssPx &&
    a.renderScale === b.renderScale &&
    a.tileHeightPx === b.tileHeightPx &&
    a.exceedsFrameLimit === b.exceedsFrameLimit &&
    a.exceedsStorage === b.exceedsStorage &&
    a.maxResident === b.maxResident &&
    a.maxTotalResident === b.maxTotalResident
  );
}

interface PendingRequest {
  scrollPx: ScrollAlignedPx;
  jumpToEnd: boolean;
}

export class Scheduler {
  private geometry: Geometry;
  private scrollPx: ScrollAlignedPx = SCROLL_TOP;
  private genCounter = 0;
  private displayGen: GenState | null = null;
  private pipeGen: GenState | null = null;
  private shootInFlight = false;
  private shootQueue: number[] = [];
  private rerun = false;
  private refetchingDisplayedGeneration = false;
  private failedGen: number | null = null;
  private pending: PendingRequest | null = null;
  private scrollFailed = false;

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
        return this.onRenderDone(event.gen, event.documentHeightPx);
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
      phase: this.pipeGen && !this.refetchingDisplayedGeneration ? "rendering" : "ready",
      failure: this.failedGen !== null || this.scrollFailed,
      pendingScrollPx: this.pending?.scrollPx ?? null,
    };
    const g = this.displayGen;
    if (!g) return { ...base, displayGen: null };
    return {
      ...base,
      displayGen: g.gen,
      tiles: g.tiles,
      resident: g.resident,
      truncated: g.truncated,
      contentHeightPx: g.contentHeightPx,
    };
  }

  private onTrigger(): Action[] {
    // Do not interrupt a page operation: once it settles, discard the remaining stale work.
    if (this.pipeGen && !this.refetchingDisplayedGeneration) {
      this.rerun = true;
      return [];
    }
    return this.startPipeline();
  }

  private onResize(geometry: Geometry): Action[] {
    // The terminal can report a resize without any dimension change; restarting the pipeline
    // then would blank a healthy display for nothing.
    if (sameGeometry(this.geometry, geometry)) return [{ type: "redraw" }];
    this.geometry = geometry;
    // A new layout invalidates scroll coordinates, so drop any outstanding scroll request.
    this.pending = null;
    // Resize invalidates captured geometry; free its images and files before rerendering.
    const old = this.displayGen;
    this.displayGen = null;
    const actions: Action[] = [];
    if (old && old !== this.pipeGen) {
      const ids = this.residentIds(old);
      if (ids.length) actions.push({ type: "deleteGen", imageIds: ids });
      actions.push({ type: "releaseGen", gen: old.gen });
    }
    if (this.pipeGen) {
      this.pipeGen.invalidatedByResize = true;
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
      contentHeightPx: NO_CONTENT_HEIGHT,
      resident: new Set(),
      truncated: false,
      invalidatedByResize: false,
    };
    this.shootQueue = [];
    this.shootInFlight = false;
    this.rerun = false;
    this.refetchingDisplayedGeneration = false;
    return [{ type: "render", gen: this.genCounter }, { type: "redraw" }];
  }

  private onKey(delta: ScrollDelta): Action[] {
    const shown = this.displayGen;
    if (!shown) return [];
    const { cellHpx, renderScale } = this.geometry;
    const contentHeightPx = shown.contentHeightPx;
    let px: number = this.pending?.scrollPx ?? this.scrollPx;
    let direction: ScrollDirection = 0;
    // Keep movement on the scroll unit so clampScroll cannot introduce drift.
    const unit = scrollUnitPx(cellHpx, renderScale);
    switch (delta.kind) {
      case "lines":
        px += delta.n * unit;
        direction = Math.sign(delta.n) as ScrollDirection;
        break;
      case "halfpage": {
        const half = Math.max(1, Math.floor(this.contentRows / 2)) * cellHpx;
        px += delta.dir * Math.max(unit, Math.round(half / unit) * unit);
        direction = delta.dir;
        break;
      }
      case "top":
        px = 0;
        direction = -1;
        break;
      case "bottom":
        px = maxScrollPx(contentHeightPx, this.contentRows, cellHpx, renderScale);
        direction = 1;
        break;
    }
    const req = clampScroll(px, contentHeightPx, this.contentRows, cellHpx, renderScale);
    const jumpToEnd = delta.kind === "bottom";
    this.pending = { scrollPx: req, jumpToEnd };
    // Fast path in the displayed generation: everything visible is already resident,
    // so the display can move without blanking. Pure prefetch continues afterwards.
    if (this.allVisibleResident(shown, req)) {
      const committed = this.pending;
      this.scrollPx = req;
      this.pending = null;
      this.scrollFailed = false;
      const pg = this.pipeGen;
      if (pg && pg.tiles.length > 0 && pg !== shown) {
        // An update is capturing: retarget its queue at the committed position.
        const pgScroll = clampScroll(req, pg.contentHeightPx, this.contentRows, cellHpx, renderScale);
        this.shootQueue = this.queueAround(pg, pgScroll, direction, this.geometry.maxResident);
        return [{ type: "redraw" }, { type: "scrollCommitted", jumpToEnd: committed.jumpToEnd }];
      }
      const actions: Action[] = [{ type: "redraw" }, { type: "scrollCommitted", jumpToEnd: committed.jumpToEnd }];
      actions.push(...this.startPrefetchIfNeeded(direction));
      return actions;
    }
    // Slow path: keep the old display while the request captures.
    const pg = this.pipeGen;
    if (pg && pg.tiles.length > 0) {
      const pgScroll =
        pg === shown
          ? req
          : clampScroll(req, pg.contentHeightPx, this.contentRows, cellHpx, renderScale);
      this.shootQueue = this.queueAround(pg, pgScroll, direction, this.geometry.maxTotalResident);
      return [{ type: "redraw" }];
    }
    if (pg) {
      // An update is still in layout: renderDone will build the queue around pending.
      return [{ type: "redraw" }];
    }
    return [{ type: "redraw" }, ...this.startRefetchForPending(direction)];
  }

  private queueAround(
    g: GenState,
    scroll: ScrollAlignedPx,
    direction: ScrollDirection = 0,
    limit: number = this.geometry.maxResident,
  ): number[] {
    // Read-ahead must never take a queue slot away from a tile needed by the current frame.
    const visible = visibleTiles(scroll, this.contentRows, this.geometry.cellHpx, g.tiles).map(
      (placement) => placement.tileIndex,
    );
    const visibleSet = new Set(visible);
    const nearby = backfillOrder(
      scroll,
      this.contentRows,
      this.geometry.cellHpx,
      g.tiles,
      direction,
    ).filter((tileIndex) => !visibleSet.has(tileIndex));
    return [...visible, ...nearby].slice(0, Math.max(0, limit));
  }

  private clampPendingToGen(g: GenState): ScrollAlignedPx | null {
    if (!this.pending) return null;
    return clampScroll(
      this.pending.scrollPx,
      g.contentHeightPx,
      this.contentRows,
      this.geometry.cellHpx,
      this.geometry.renderScale,
    );
  }

  private visibleSet(g: GenState, scroll: ScrollAlignedPx): Set<number> {
    return new Set(
      visibleTiles(scroll, this.contentRows, this.geometry.cellHpx, g.tiles).map(
        (placement) => placement.tileIndex,
      ),
    );
  }

  /** Tiles that must survive eviction: the display plus any outstanding request. */
  private protectedSet(g: GenState): Set<number> {
    const out = new Set<number>();
    if (g === this.displayGen) {
      for (const t of this.visibleSet(g, this.scrollPx)) out.add(t);
      const pend = this.clampPendingToGen(g);
      if (pend !== null && this.pending) {
        // Keep fallback tiles for the old generation even while a new one captures,
        // so an update failure can resume the requested scroll from the old pixels.
        for (const t of this.visibleSet(g, pend)) out.add(t);
      }
      return out;
    }
    if (g === this.pipeGen) {
      const pend = this.clampPendingToGen(g);
      if (pend !== null) return this.visibleSet(g, pend);
      return this.visibleSet(g, this.scrollFor(g));
    }
    return this.visibleSet(g, this.scrollFor(g));
  }

  /** Steady prefetch around the display after a fast commit; no temporary burst. */
  private startPrefetchIfNeeded(direction: ScrollDirection): Action[] {
    const g = this.displayGen;
    if (!g || this.pipeGen || g.tiles.length === 0) return [];
    const queue = this.queueAround(g, this.scrollPx, direction, this.geometry.maxResident);
    if (queue.every((tileIndex) => g.resident.has(tileIndex))) return [];
    this.pipeGen = g;
    this.refetchingDisplayedGeneration = true;
    this.shootQueue = queue;
    return this.drive();
  }

  /** Slow-path capture for pending while keeping the old display on screen. */
  private startRefetchForPending(direction: ScrollDirection): Action[] {
    const g = this.displayGen;
    const pend = g ? this.clampPendingToGen(g) : null;
    if (!g || pend === null || this.pipeGen || g.tiles.length === 0) return [];
    const queue = this.queueAround(g, pend, direction, this.geometry.maxTotalResident);
    if (queue.every((tileIndex) => g.resident.has(tileIndex))) return [];
    this.pipeGen = g;
    this.refetchingDisplayedGeneration = true;
    this.shootQueue = queue;
    return this.drive();
  }

  private onRenderDone(gen: number, documentHeightPx: number): Action[] {
    const g = this.pipeGen;
    if (!g || g.gen !== gen) return [];
    if (g.invalidatedByResize || this.rerun) return this.abortStalePipeline();

    const { tiles, truncated, contentHeightPx } = computeTiles(
      documentHeightPx,
      this.geometry.cellHpx,
      this.contentRows,
      this.geometry.tileHeightPx,
    );
    g.tiles = tiles;
    g.truncated = truncated;
    g.contentHeightPx = contentHeightPx;
    const { cellHpx, renderScale } = this.geometry;
    const base = this.pending?.scrollPx ?? this.scrollPx;
    const promoScroll = clampScroll(base, contentHeightPx, this.contentRows, cellHpx, renderScale);
    const limit = this.pending ? this.geometry.maxTotalResident : this.geometry.maxResident;
    this.shootQueue = this.queueAround(g, promoScroll, 0, limit);
    return this.drive();
  }

  private onRenderFailed(gen: number): Action[] {
    const g = this.pipeGen;
    if (!g || g.gen !== gen) return [];
    // On failure, discard unpromoted images and files; promoted images stay visible and are recaptured later.
    const promoted = this.displayGen === g;
    this.pipeGen = null;
    this.shootQueue = [];
    this.shootInFlight = false;
    this.refetchingDisplayedGeneration = false;
    const actions: Action[] = [];
    if (!promoted) {
      const ids = this.residentIds(g);
      if (ids.length) actions.push({ type: "deleteGen", imageIds: ids });
      actions.push({ type: "releaseGen", gen: g.gen });
      this.failedGen = g.gen;
      if (this.rerun) {
        // A coalesced update wins over resuming the old scroll; pending retargets at renderDone.
        actions.push({ type: "redraw" });
        actions.push(...this.startPipeline());
        return actions;
      }
      const shown = this.displayGen;
      const pend = shown ? this.clampPendingToGen(shown) : null;
      if (shown && pend !== null && this.pending) {
        if (this.allVisibleResident(shown, pend)) {
          const committed = this.pending;
          this.scrollPx = pend;
          this.pending = null;
          this.scrollFailed = false;
          actions.push({ type: "redraw" });
          actions.push({ type: "scrollCommitted", jumpToEnd: committed.jumpToEnd });
          actions.push(...this.startPrefetchIfNeeded(0));
          return actions;
        }
        this.pipeGen = shown;
        this.refetchingDisplayedGeneration = true;
        this.shootQueue = this.queueAround(shown, pend, 0, this.geometry.maxTotalResident);
        actions.push({ type: "redraw" });
        actions.push(...this.drive());
        return actions;
      }
      actions.push({ type: "redraw" });
      return actions;
    }
    if (this.pending) {
      // The requested move is abandoned but the old display stays usable.
      this.pending = null;
      this.scrollFailed = true;
      const shown = this.displayGen!;
      const freed = this.evictToSize(shown, this.geometry.maxResident);
      actions.push({ type: "redraw" });
      if (freed.length) actions.push({ type: "deleteGen", imageIds: freed });
      if (this.rerun) actions.push(...this.startPipeline());
      return actions;
    }
    actions.push({ type: "redraw" });
    if (this.rerun) actions.push(...this.startPipeline());
    return actions;
  }

  private onTileReady(gen: number, tileIndex: number): Action[] {
    const g = this.pipeGen;
    if (!g || g.gen !== gen) {
      // A late tile for the displayed generation is still usable; otherwise delete it.
      const shown = this.displayGen;
      if (shown && shown.gen === gen) {
        shown.resident.add(tileIndex);
        const pend = this.clampPendingToGen(shown);
        if (pend !== null && this.pending && this.allVisibleResident(shown, pend)) {
          const committed = this.pending;
          this.scrollPx = pend;
          this.pending = null;
          this.scrollFailed = false;
          const freed = this.evictToSize(shown, this.geometry.maxResident);
          const actions: Action[] = [
            { type: "redraw" },
            { type: "scrollCommitted", jumpToEnd: committed.jumpToEnd },
          ];
          if (freed.length) actions.push({ type: "deleteGen", imageIds: freed });
          return actions;
        }
        const limit = this.pending ? this.geometry.maxTotalResident : this.geometry.maxResident;
        const freed = this.evictToSize(shown, limit);
        const actions: Action[] = [{ type: "redraw" }];
        if (freed.length) actions.push({ type: "deleteGen", imageIds: freed });
        return actions;
      }
      return [{ type: "deleteGen", imageIds: [imageId(gen, tileIndex)] }];
    }
    this.shootInFlight = false;
    g.resident.add(tileIndex);
    if (g.invalidatedByResize || this.rerun) return this.abortStalePipeline();
    const usesTemporary = this.pending !== null && g === this.pipeGen;
    const freed = this.evictToSize(g, usesTemporary ? this.geometry.maxTotalResident : this.geometry.maxResident);
    const actions = this.drive();
    const withRedraw = actions[0]?.type === "redraw" ? actions : [{ type: "redraw" } as Action, ...actions];
    return freed.length ? [...withRedraw, { type: "deleteGen", imageIds: freed }] : withRedraw;
  }

  private scrollFor(g: GenState): ScrollAlignedPx {
    if (g === this.displayGen) return this.scrollPx;
    const base = this.pending?.scrollPx ?? this.scrollPx;
    return clampScroll(
      base,
      g.contentHeightPx,
      this.contentRows,
      this.geometry.cellHpx,
      this.geometry.renderScale,
    );
  }

  // Visible tiles are never evicted because doing so would punch a black hole in the current frame.
  // While a scroll is outstanding, its target joins the protected set so the request can complete.
  private evictToSize(g: GenState, maxSize: number): number[] {
    if (g.resident.size <= maxSize) return [];
    const visible = this.protectedSet(g);
    const order = backfillOrder(this.scrollFor(g), this.contentRows, this.geometry.cellHpx, g.tiles);
    const freed: number[] = [];
    for (let i = order.length - 1; i >= 0 && g.resident.size > maxSize; i--) {
      const tileIndex = order[i]!;
      if (!g.resident.has(tileIndex) || visible.has(tileIndex)) continue;
      g.resident.delete(tileIndex);
      freed.push(imageId(g.gen, tileIndex));
    }
    return freed;
  }

  /** Discards an unpromoted pipeline generation and starts the next one. */
  private abortStalePipeline(): Action[] {
    // Free transferred images and files before replacing the invalidated generation.
    const g = this.pipeGen!;
    const actions: Action[] = [];
    if (g !== this.displayGen) {
      const ids = this.residentIds(g);
      if (ids.length) actions.push({ type: "deleteGen", imageIds: ids });
      actions.push({ type: "releaseGen", gen: g.gen });
    }
    actions.push(...this.startPipeline());
    return actions;
  }

  private drive(): Action[] {
    const g = this.pipeGen;
    if (!g) return [];
    const { cellHpx, renderScale } = this.geometry;
    const actions: Action[] = [];

    if (this.displayGen !== g) {
      const base = this.pending?.scrollPx ?? this.scrollPx;
      const promoScroll = clampScroll(base, g.contentHeightPx, this.contentRows, cellHpx, renderScale);
      if (this.allVisibleResident(g, promoScroll)) {
        const old = this.displayGen;
        const committed = this.pending;
        this.scrollPx = promoScroll;
        this.displayGen = g;
        this.pending = null;
        if (committed) this.scrollFailed = false;
        if (this.failedGen !== null && g.gen >= this.failedGen) this.failedGen = null;
        // Place the new generation before deleting the old one to avoid a blank frame between them.
        actions.push({ type: "redraw" });
        if (committed) actions.push({ type: "scrollCommitted", jumpToEnd: committed.jumpToEnd });
        if (old) {
          const ids = this.residentIds(old);
          if (ids.length) actions.push({ type: "deleteGen", imageIds: ids });
          actions.push({ type: "releaseGen", gen: old.gen });
        }
        const shrunk = this.evictToSize(g, this.geometry.maxResident);
        if (shrunk.length) actions.push({ type: "deleteGen", imageIds: shrunk });
      }
    } else if (this.pending) {
      // Same-generation scroll: switch the display only once its tiles are resident.
      const pend = this.clampPendingToGen(g);
      if (pend !== null && this.allVisibleResident(g, pend)) {
        const committed = this.pending;
        this.scrollPx = pend;
        this.pending = null;
        if (committed) this.scrollFailed = false;
        actions.push({ type: "redraw" });
        if (committed) actions.push({ type: "scrollCommitted", jumpToEnd: committed.jumpToEnd });
        const shrunk = this.evictToSize(g, this.geometry.maxResident);
        if (shrunk.length) actions.push({ type: "deleteGen", imageIds: shrunk });
      }
    }

    if (!this.shootInFlight) {
      const next = this.nextShoot();
      if (next !== null) {
        let old = this.displayGen !== g ? this.displayGen : null;
        if (old) {
          const freedOld = this.evictToSize(old, this.geometry.maxTotalResident - g.resident.size - 1);
          if (freedOld.length) actions.push({ type: "deleteGen", imageIds: freedOld });
        }
        const temporary = this.pending !== null && g === this.pipeGen;
        // The terminal receives the transfer before tileReady, so reserve decoded storage first.
        // While a scroll is outstanding the new generation may burst to the total budget;
        // the steady per-generation cap is restored by the post-commit shrink above.
        const newBudget = temporary
          ? this.geometry.maxTotalResident - (old?.resident.size ?? 0) - 1
          : Math.min(
              this.geometry.maxResident - 1,
              this.geometry.maxTotalResident - (old?.resident.size ?? 0) - 1,
            );
        const freed = this.evictToSize(g, newBudget);
        if (freed.length) actions.push({ type: "deleteGen", imageIds: freed });
        const oldSize = old?.resident.size ?? 0;
        const newSize = g.resident.size;
        const fitsTotal = oldSize + newSize + 1 <= this.geometry.maxTotalResident;
        const fits = temporary
          ? fitsTotal
          : newSize + 1 <= this.geometry.maxResident && fitsTotal;
        if (!fits) {
          if (this.geometry.exceedsStorage && old) {
            // Single-generation mode: old+new can never fit, so drop the old display now
            // instead of overflowing terminal storage with the third image.
            // evictToSize already removed read-ahead from resident, so the remainder is visible.
            const ids = this.residentIds(old);
            if (ids.length) actions.push({ type: "deleteGen", imageIds: ids });
            actions.push({ type: "releaseGen", gen: old.gen });
            this.displayGen = null;
            old = null;
            const retryTotal = g.resident.size + 1 <= this.geometry.maxTotalResident;
            const retryResident = g.resident.size + 1 <= this.geometry.maxResident;
            if (retryTotal && retryResident) {
              this.shootInFlight = true;
              actions.push(this.shootAction(g, next));
            } else {
              // Even alone the next image does not fit: settle as capped so update/resize can retry.
              this.settleStalled(g, actions);
            }
          } else {
            // Not enough evictable (non-visible) tiles: settle as capped so update/resize can retry.
            this.settleStalled(g, actions);
          }
        } else {
          this.shootInFlight = true;
          actions.push(this.shootAction(g, next));
        }
      } else if (this.displayGen === g) {
        if (this.pending) {
          // Queue exhausted but the request is still incomplete: abandon the move,
          // keep the old display, and evict only the unneeded fetch results.
          this.settleStalled(g, actions);
        } else {
          this.pipeGen = null;
          this.refetchingDisplayedGeneration = false;
          if (this.rerun) actions.push(...this.startPipeline());
        }
      } else {
        // Queue exhausted but visible incomplete: capacity shortage, not processing.
        // Settle as capped so update/resize can retry instead of leaving rendering stuck.
        this.settleStalled(g, actions);
      }
    }
    return actions;
  }

  private residentIds(g: GenState): number[] {
    return Array.from(g.resident, (i) => imageId(g.gen, i));
  }

  /**
   * Capacity shortage is settled, not processing: drop the undisplayable generation so a later
   * update or resize can retry, instead of leaving displayGen:null/phase:rendering stuck with an
   * exhausted (or permanently blocked) queue that no tileReady will ever resume.
   *
   * Same-generation stalls abandon the move instead: the old display stays, only the
   * unneeded fetch results are evicted, and the generation (HTML/map) is kept.
   */
  private settleStalled(g: GenState, actions: Action[]): void {
    if (g === this.displayGen) {
      // Abandoning a requested move is a scroll failure like a refetch renderFailed;
      // a prefetch stall with no outstanding request leaves the failure state alone.
      if (this.pending) this.scrollFailed = true;
      this.pending = null;
      if (this.pipeGen === g) this.pipeGen = null;
      this.shootQueue = [];
      this.shootInFlight = false;
      this.refetchingDisplayedGeneration = false;
      // Show the settled display (clearing the scroll-waiting state) before
      // deleting images the old position no longer needs.
      actions.push({ type: "redraw" });
      const freed = this.evictToSize(g, this.geometry.maxResident);
      if (freed.length) actions.push({ type: "deleteGen", imageIds: freed });
      if (this.rerun) actions.push(...this.startPipeline());
      return;
    }
    const ids = this.residentIds(g);
    if (ids.length) actions.push({ type: "deleteGen", imageIds: ids });
    actions.push({ type: "releaseGen", gen: g.gen });
    if (this.pipeGen === g) this.pipeGen = null;
    this.shootQueue = [];
    this.shootInFlight = false;
    this.refetchingDisplayedGeneration = false;
    const shown = this.displayGen;
    const pend = shown ? this.clampPendingToGen(shown) : null;
    if (shown && pend !== null && this.pending) {
      if (this.allVisibleResident(shown, pend)) {
        const committed = this.pending;
        this.scrollPx = pend;
        this.pending = null;
        this.scrollFailed = false;
        actions.push({ type: "redraw" });
        actions.push({ type: "scrollCommitted", jumpToEnd: committed.jumpToEnd });
        actions.push(...this.startPrefetchIfNeeded(0));
        return;
      }
      this.pipeGen = shown;
      this.refetchingDisplayedGeneration = true;
      this.shootQueue = this.queueAround(shown, pend, 0, this.geometry.maxTotalResident);
      actions.push({ type: "redraw" });
      actions.push(...this.drive());
      return;
    }
    actions.push({ type: "redraw" });
    if (this.rerun) actions.push(...this.startPipeline());
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
    const { viewportWidthCssPx } = this.geometry;
    return {
      type: "shoot",
      gen: g.gen,
      tileIndex,
      clip: {
        xCssPx: 0,
        yCssPx: tile.topPx / CSS_SCALE,
        widthCssPx: viewportWidthCssPx,
        heightCssPx: tile.heightPx / CSS_SCALE,
      },
    };
  }

  private allVisibleResident(g: GenState, scroll: ScrollAlignedPx): boolean {
    const vis = visibleTiles(scroll, this.contentRows, this.geometry.cellHpx, g.tiles);
    return vis.every((p) => g.resident.has(p.tileIndex));
  }
}
