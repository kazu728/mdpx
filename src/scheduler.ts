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
  | { type: "releaseGen"; gen: number };

type Phase = "rendering" | "ready";

interface ViewBase {
  geometry: Geometry;
  scrollPx: ScrollAlignedPx;
  phase: Phase;
  /** The last render failed and no newer generation has displayed since. */
  failure: boolean;
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
      failure: this.failedGen !== null,
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
    if (!this.displayGen) return [];
    const { cellHpx, renderScale } = this.geometry;
    const contentHeightPx = this.displayGen.contentHeightPx;
    let px: number = this.scrollPx;
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
    this.scrollPx = clampScroll(px, contentHeightPx, this.contentRows, cellHpx, renderScale);
    // Rebuild capture order around the new position so visible tiles promote first.
    const pg = this.pipeGen;
    if (pg && pg.tiles.length > 0) {
      const pgScroll =
        pg === this.displayGen
          ? this.scrollPx
          : clampScroll(this.scrollPx, pg.contentHeightPx, this.contentRows, cellHpx, renderScale);
      this.shootQueue = this.queueAround(pg, pgScroll, direction);
      return [{ type: "redraw" }];
    }
    return [{ type: "redraw" }, ...this.refetchAround(direction)];
  }

  private queueAround(
    g: GenState,
    scroll: ScrollAlignedPx,
    direction: ScrollDirection = 0,
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
    return [...visible, ...nearby].slice(0, this.geometry.maxResident);
  }

  private refetchAround(direction: ScrollDirection): Action[] {
    const g = this.displayGen;
    if (!g || this.pipeGen || g.tiles.length === 0) return [];
    const queue = this.queueAround(g, this.scrollPx, direction);
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
    const promoScroll = clampScroll(
      this.scrollPx,
      contentHeightPx,
      this.contentRows,
      cellHpx,
      renderScale,
    );
    this.shootQueue = this.queueAround(g, promoScroll);
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
    const actions: Action[] = [];
    if (!promoted) {
      const ids = this.residentIds(g);
      if (ids.length) actions.push({ type: "deleteGen", imageIds: ids });
      actions.push({ type: "releaseGen", gen: g.gen });
      this.failedGen = g.gen;
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
        const freed = this.evictToSize(shown, this.geometry.maxResident);
        const actions: Action[] = [{ type: "redraw" }];
        if (freed.length) actions.push({ type: "deleteGen", imageIds: freed });
        return actions;
      }
      return [{ type: "deleteGen", imageIds: [imageId(gen, tileIndex)] }];
    }
    this.shootInFlight = false;
    g.resident.add(tileIndex);
    if (g.invalidatedByResize || this.rerun) return this.abortStalePipeline();
    const freed = this.evictToSize(g, this.geometry.maxResident);
    const actions = this.drive();
    const withRedraw = actions[0]?.type === "redraw" ? actions : [{ type: "redraw" } as Action, ...actions];
    return freed.length ? [...withRedraw, { type: "deleteGen", imageIds: freed }] : withRedraw;
  }

  private scrollFor(g: GenState): ScrollAlignedPx {
    if (g === this.displayGen) return this.scrollPx;
    return clampScroll(
      this.scrollPx,
      g.contentHeightPx,
      this.contentRows,
      this.geometry.cellHpx,
      this.geometry.renderScale,
    );
  }

  // Visible tiles are never evicted because doing so would punch a black hole in the current frame.
  private evictToSize(g: GenState, maxSize: number): number[] {
    if (g.resident.size <= maxSize) return [];
    const scroll = this.scrollFor(g);
    const visible = new Set(
      visibleTiles(scroll, this.contentRows, this.geometry.cellHpx, g.tiles).map(
        (placement) => placement.tileIndex,
      ),
    );
    const order = backfillOrder(scroll, this.contentRows, this.geometry.cellHpx, g.tiles);
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
      const promoScroll = clampScroll(
        this.scrollPx,
        g.contentHeightPx,
        this.contentRows,
        cellHpx,
        renderScale,
      );
      if (this.allVisibleResident(g, promoScroll)) {
        const old = this.displayGen;
        this.scrollPx = promoScroll;
        this.displayGen = g;
        if (this.failedGen !== null && g.gen >= this.failedGen) this.failedGen = null;
        // Place the new generation before deleting the old one to avoid a blank frame between them.
        actions.push({ type: "redraw" });
        if (old) {
          const ids = this.residentIds(old);
          if (ids.length) actions.push({ type: "deleteGen", imageIds: ids });
          actions.push({ type: "releaseGen", gen: old.gen });
        }
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
        // The terminal receives the transfer before tileReady, so reserve decoded storage first.
        const newBudget = Math.min(
          this.geometry.maxResident - 1,
          this.geometry.maxTotalResident - (old?.resident.size ?? 0) - 1,
        );
        const freed = this.evictToSize(g, newBudget);
        if (freed.length) actions.push({ type: "deleteGen", imageIds: freed });
        const oldSize = old?.resident.size ?? 0;
        const newSize = g.resident.size;
        const fitsResident = newSize + 1 <= this.geometry.maxResident;
        const fitsTotal = oldSize + newSize + 1 <= this.geometry.maxTotalResident;
        if (!fitsResident || !fitsTotal) {
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
        this.pipeGen = null;
        this.refetchingDisplayedGeneration = false;
        if (this.rerun) actions.push(...this.startPipeline());
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
   */
  private settleStalled(g: GenState, actions: Action[]): void {
    const ids = this.residentIds(g);
    if (ids.length) actions.push({ type: "deleteGen", imageIds: ids });
    actions.push({ type: "releaseGen", gen: g.gen });
    if (this.pipeGen === g) this.pipeGen = null;
    this.shootQueue = [];
    this.shootInFlight = false;
    this.refetchingDisplayedGeneration = false;
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
