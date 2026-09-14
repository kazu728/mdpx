import {
  backfillOrder,
  clampScroll,
  computeTiles,
  contentRows,
  CSS_SCALE,
  maxScrollPx,
  scrollUnitPx,
  visibleTiles,
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
  scrollPx: number;
  phase: Phase;
  failure: boolean;
  pendingScrollPx: number | null;
}

export interface BlankView extends ViewBase {
  displayGen: null;
}

export interface GenView extends ViewBase {
  displayGen: number;
  tiles: Tile[];
  resident: ReadonlySet<number>;
  truncated: boolean;
  contentHeightPx: number;
}

/** No displayed generation vs. a displayed empty document. */
export type ViewState = BlankView | GenView;

interface GenState {
  gen: number;
  tiles: Tile[];
  contentHeightPx: number;
  resident: Set<number>;
  truncated: boolean;
  invalidatedByResize: boolean;
}

const GEOMETRY_KEYS = [
  "rows",
  "cols",
  "cellHpx",
  "imgWidthPx",
  "viewportWidthCssPx",
  "renderScale",
  "tileHeightPx",
  "exceedsFrameLimit",
  "exceedsStorage",
  "maxResident",
  "maxTotalResident",
] as const;

function sameGeometry(a: Geometry, b: Geometry): boolean {
  return GEOMETRY_KEYS.every((k) => a[k] === b[k]);
}

interface PendingRequest {
  scrollPx: number;
  jumpToEnd: boolean;
}

export class Scheduler {
  private geometry: Geometry;
  private scrollPx = 0;
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
    if (this.pipeGen && !this.refetchingDisplayedGeneration) {
      this.rerun = true;
      return [];
    }
    return this.startPipeline();
  }

  private onResize(geometry: Geometry): Action[] {
    if (sameGeometry(this.geometry, geometry)) return [{ type: "redraw" }];
    this.geometry = geometry;
    this.pending = null;
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
      contentHeightPx: 0,
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
    if (this.allVisibleResident(shown, req)) {
      const committed = this.pending;
      this.scrollPx = req;
      this.pending = null;
      this.scrollFailed = false;
      const pg = this.pipeGen;
      if (pg && pg.tiles.length > 0 && pg !== shown) {
        const pgScroll = clampScroll(req, pg.contentHeightPx, this.contentRows, cellHpx, renderScale);
        this.shootQueue = this.queueAround(pg, pgScroll, direction, this.geometry.maxResident);
        return [{ type: "redraw" }, { type: "scrollCommitted", jumpToEnd: committed.jumpToEnd }];
      }
      const actions: Action[] = [{ type: "redraw" }, { type: "scrollCommitted", jumpToEnd: committed.jumpToEnd }];
      actions.push(...this.startPrefetchIfNeeded(direction));
      return actions;
    }
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
      return [{ type: "redraw" }];
    }
    return [{ type: "redraw" }, ...this.startRefetchForPending(direction)];
  }

  private queueAround(
    g: GenState,
    scroll: number,
    direction: ScrollDirection = 0,
    limit: number = this.geometry.maxResident,
  ): number[] {
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

  private clampPendingToGen(g: GenState): number | null {
    if (!this.pending) return null;
    return clampScroll(
      this.pending.scrollPx,
      g.contentHeightPx,
      this.contentRows,
      this.geometry.cellHpx,
      this.geometry.renderScale,
    );
  }

  private takeCommitted(g: GenState): { jumpToEnd: boolean } | null {
    const pend = this.clampPendingToGen(g);
    if (pend === null || !this.pending || !this.allVisibleResident(g, pend)) return null;
    const committed = this.pending;
    this.scrollPx = pend;
    this.pending = null;
    this.scrollFailed = false;
    return { jumpToEnd: committed.jumpToEnd };
  }

  private visibleSet(g: GenState, scroll: number): Set<number> {
    return new Set(
      visibleTiles(scroll, this.contentRows, this.geometry.cellHpx, g.tiles).map(
        (placement) => placement.tileIndex,
      ),
    );
  }

  // Display plus any outstanding request must survive eviction.
  private protectedSet(g: GenState): Set<number> {
    const out = new Set<number>();
    if (g === this.displayGen) {
      for (const t of this.visibleSet(g, this.scrollPx)) out.add(t);
      const pend = this.clampPendingToGen(g);
      if (pend !== null && this.pending) {
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
        actions.push({ type: "redraw" });
        actions.push(...this.startPipeline());
        return actions;
      }
      const shown = this.displayGen;
      const pend = shown ? this.clampPendingToGen(shown) : null;
      if (shown && pend !== null && this.pending) {
        const committed = this.takeCommitted(shown);
        if (committed) {
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
      const shown = this.displayGen;
      if (shown && shown.gen === gen) {
        shown.resident.add(tileIndex);
        const committed = this.takeCommitted(shown);
        if (committed) {
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

  private scrollFor(g: GenState): number {
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

  private abortStalePipeline(): Action[] {
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
      const committed = this.takeCommitted(g);
      if (committed) {
        actions.push({ type: "redraw" });
        actions.push({ type: "scrollCommitted", jumpToEnd: committed.jumpToEnd });
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
        // Reserve decoded storage before the transfer lands; a pending scroll may burst
        // to the total budget until the post-commit shrink restores the steady cap.
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
            // Single-generation mode: drop the old display instead of overflowing storage.
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
              this.settleStalled(g, actions);
            }
          } else {
            this.settleStalled(g, actions);
          }
        } else {
          this.shootInFlight = true;
          actions.push(this.shootAction(g, next));
        }
      } else if (this.displayGen === g) {
        if (this.pending) {
          this.settleStalled(g, actions);
        } else {
          this.pipeGen = null;
          this.refetchingDisplayedGeneration = false;
          if (this.rerun) actions.push(...this.startPipeline());
        }
      } else {
        this.settleStalled(g, actions);
      }
    }
    return actions;
  }

  private residentIds(g: GenState): number[] {
    return Array.from(g.resident, (i) => imageId(g.gen, i));
  }

  // Shortage settles instead of sticking in rendering: drop the undisplayable
  // generation so a later update/resize can retry. Same-generation stalls keep
  // the display and only evict unneeded fetches.
  private settleStalled(g: GenState, actions: Action[]): void {
    if (g === this.displayGen) {
      if (this.pending) this.scrollFailed = true;
      this.pending = null;
      if (this.pipeGen === g) this.pipeGen = null;
      this.shootQueue = [];
      this.shootInFlight = false;
      this.refetchingDisplayedGeneration = false;
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
      const committed = this.takeCommitted(shown);
      if (committed) {
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

  private allVisibleResident(g: GenState, scroll: number): boolean {
    const vis = visibleTiles(scroll, this.contentRows, this.geometry.cellHpx, g.tiles);
    return vis.every((p) => g.resident.has(p.tileIndex));
  }
}
