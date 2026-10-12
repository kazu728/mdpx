import {
  backfillOrder,
  clampScroll,
  computeTiles,
  contentRows,
  maxScrollPx,
  scrollUnitPx,
  visibleTiles,
  type Geometry,
  type ScrollDirection,
  type Tile,
} from "./geometry.ts";
import { imageId } from "./kitty.ts";

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
  | { type: "shoot"; gen: number; tileIndex: number; tile: Tile }
  | { type: "redraw" }
  | { type: "deleteGen"; imageIds: number[] }
  | { type: "releaseGen"; gen: number };

type Phase = "rendering" | "ready";

interface GenState {
  gen: number;
  tiles: Tile[];
  contentHeightPx: number;
  resident: Set<number>;
  truncated: boolean;
}

export interface ViewState {
  geometry: Geometry;
  scrollPx: number;
  phase: Phase;
  failure: boolean;
  pendingScrollPx: number | null;
  /** No displayed generation vs. a displayed empty document. */
  displayGen: Readonly<GenState> | null;
}

interface Capture {
  target: GenState;
  // "render" lasts through the backfill after promotion, so triggers coalesce and the
  // status shows "updating"; "refetch" yields to a new trigger immediately.
  reason: "render" | "refetch";
  queue: number[];
  inFlight: boolean;
}

function sameGeometry(a: Geometry, b: Geometry): boolean {
  return (Object.keys(a) as (keyof Geometry)[]).every((k) => a[k] === b[k]);
}

export class Scheduler {
  private geometry: Geometry;
  private scrollPx = 0;
  private genCounter = 0;
  private displayGen: GenState | null = null;
  private capture: Capture | null = null;
  private rerun = false;
  private failedGen: number | null = null;
  private pendingScrollPx: number | null = null;
  private scrollFailed = false;

  constructor(geometry: Geometry) {
    this.geometry = geometry;
  }

  private get contentRows(): number {
    return contentRows(this.geometry.rows);
  }

  // A pending scroll may burst to the total budget until it commits.
  private get residentLimit(): number {
    return this.pendingScrollPx !== null ? this.geometry.maxTotalResident : this.geometry.maxResident;
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
    return {
      geometry: this.geometry,
      scrollPx: this.scrollPx,
      phase: this.capture?.reason === "render" ? "rendering" : "ready",
      failure: this.failedGen !== null || this.scrollFailed,
      pendingScrollPx: this.pendingScrollPx,
      displayGen: this.displayGen,
    };
  }

  private onTrigger(): Action[] {
    if (this.capture?.reason === "render") {
      this.rerun = true;
      return [];
    }
    return this.startPipeline();
  }

  private onResize(geometry: Geometry): Action[] {
    if (sameGeometry(this.geometry, geometry)) return [{ type: "redraw" }];
    this.geometry = geometry;
    this.pendingScrollPx = null;
    const old = this.displayGen;
    this.displayGen = null;
    const actions: Action[] = [];
    if (old && old !== this.capture?.target) {
      this.pushReleaseGen(old, actions);
    }
    if (this.capture) {
      this.rerun = true;
      actions.push({ type: "redraw" });
      return actions;
    }
    actions.push(...this.startPipeline());
    return actions;
  }

  private startPipeline(): Action[] {
    this.genCounter += 1;
    this.capture = {
      target: {
        gen: this.genCounter,
        tiles: [],
        contentHeightPx: 0,
        resident: new Set(),
        truncated: false,
      },
      reason: "render",
      queue: [],
      inFlight: false,
    };
    this.rerun = false;
    return [{ type: "render", gen: this.genCounter }, { type: "redraw" }];
  }

  private onKey(delta: ScrollDelta): Action[] {
    const shown = this.displayGen;
    if (!shown) return [];
    const { cellHpx, renderScale } = this.geometry;
    const contentHeightPx = shown.contentHeightPx;
    let px: number = this.pendingScrollPx ?? this.scrollPx;
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
    this.pendingScrollPx = req;
    const capture = this.capture;
    if (this.takeCommitted(shown)) {
      if (capture && capture.target.tiles.length > 0 && capture.target !== shown) {
        capture.queue = this.queueAround(
          capture.target,
          this.scrollFor(capture.target),
          direction,
          this.geometry.maxResident,
        );
        return [{ type: "redraw" }];
      }
      return [{ type: "redraw" }, ...this.startPrefetchIfNeeded(direction)];
    }
    if (capture) {
      if (capture.target.tiles.length > 0) {
        capture.queue = this.queueAround(
          capture.target,
          this.clampPendingToGen(capture.target)!,
          direction,
          this.geometry.maxTotalResident,
        );
      }
      return [{ type: "redraw" }];
    }
    return [{ type: "redraw" }, ...this.beginFetch(shown, req, this.geometry.maxTotalResident, direction)];
  }

  private queueAround(
    g: GenState,
    scroll: number,
    direction: ScrollDirection,
    limit: number,
  ): number[] {
    const visible = this.visibleSet(g, scroll);
    const nearby = backfillOrder(
      scroll,
      this.contentRows,
      this.geometry.cellHpx,
      g.tiles,
      direction,
    ).filter((tileIndex) => !visible.has(tileIndex));
    return [...visible, ...nearby].slice(0, Math.max(0, limit));
  }

  private clampPendingToGen(g: GenState): number | null {
    if (this.pendingScrollPx === null) return null;
    return clampScroll(
      this.pendingScrollPx,
      g.contentHeightPx,
      this.contentRows,
      this.geometry.cellHpx,
      this.geometry.renderScale,
    );
  }

  private beginFetch(
    g: GenState,
    scroll: number,
    limit: number,
    direction: ScrollDirection,
  ): Action[] {
    const queue = this.queueAround(g, scroll, direction, limit);
    if (queue.every((tileIndex) => g.resident.has(tileIndex))) return [];
    this.capture = { target: g, reason: "refetch", queue, inFlight: false };
    return this.drive();
  }

  private shrinkQueueToSteady(capture: Capture): void {
    const g = capture.target;
    capture.queue = this.queueAround(g, this.scrollFor(g), 0, this.geometry.maxResident).filter(
      (tileIndex) => !g.resident.has(tileIndex),
    );
  }

  private takeCommitted(g: GenState): boolean {
    const pend = this.clampPendingToGen(g);
    if (pend === null || !this.allVisibleResident(g, pend)) return false;
    this.scrollPx = pend;
    this.pendingScrollPx = null;
    this.scrollFailed = false;
    return true;
  }

  private visibleSet(g: GenState, scroll: number): Set<number> {
    return new Set(
      visibleTiles(scroll, this.contentRows, this.geometry.cellHpx, g.tiles).map(
        (placement) => placement.tileIndex,
      ),
    );
  }

  // Display plus any outstanding request must survive eviction.
  // Non-displayed generations are positioned by scrollFor, which already
  // clamps the pending scroll when one exists.
  private protectedSet(g: GenState): Set<number> {
    if (g === this.displayGen) {
      const out = new Set<number>();
      for (const t of this.visibleSet(g, this.scrollPx)) out.add(t);
      const pend = this.clampPendingToGen(g);
      if (pend !== null) {
        for (const t of this.visibleSet(g, pend)) out.add(t);
      }
      return out;
    }
    return this.visibleSet(g, this.scrollFor(g));
  }

  private startPrefetchIfNeeded(direction: ScrollDirection): Action[] {
    const g = this.displayGen;
    if (!g || this.capture || g.tiles.length === 0) return [];
    return this.beginFetch(g, this.scrollPx, this.geometry.maxResident, direction);
  }

  private onRenderDone(gen: number, documentHeightPx: number): Action[] {
    const capture = this.capture;
    if (!capture || capture.target.gen !== gen) return [];
    if (this.rerun) return this.abortStalePipeline();
    const g = capture.target;

    const { tiles, truncated, contentHeightPx } = computeTiles(
      documentHeightPx,
      this.geometry.cellHpx,
      this.contentRows,
      this.geometry.tileHeightPx,
    );
    g.tiles = tiles;
    g.truncated = truncated;
    g.contentHeightPx = contentHeightPx;
    capture.queue = this.queueAround(g, this.scrollFor(g), 0, this.residentLimit);
    return this.drive();
  }

  private onRenderFailed(gen: number): Action[] {
    const g = this.capture?.target;
    if (!g || g.gen !== gen) return [];
    const actions: Action[] = [];
    if (this.displayGen !== g) {
      this.failedGen = g.gen;
      if (this.rerun) {
        this.pushReleaseGen(g, actions);
        actions.push({ type: "redraw" });
        actions.push(...this.startPipeline());
        return actions;
      }
    }
    this.settleStalled(g, actions);
    return actions;
  }

  private onTileReady(gen: number, tileIndex: number): Action[] {
    const capture = this.capture;
    if (!capture || capture.target.gen !== gen) {
      const shown = this.displayGen;
      if (shown && shown.gen === gen) {
        shown.resident.add(tileIndex);
        const committed = this.takeCommitted(shown);
        const actions: Action[] = [{ type: "redraw" }];
        this.pushEvict(shown, this.residentLimit, actions);
        if (committed && this.capture) this.shrinkQueueToSteady(this.capture);
        return actions;
      }
      return [{ type: "deleteGen", imageIds: [imageId(gen, tileIndex)] }];
    }
    const g = capture.target;
    capture.inFlight = false;
    g.resident.add(tileIndex);
    if (this.rerun) return this.abortStalePipeline();
    const freed = this.evictToSize(g, this.residentLimit);
    const actions = this.drive();
    const withRedraw: Action[] = actions[0]?.type === "redraw" ? actions : [{ type: "redraw" }, ...actions];
    return freed.length ? [...withRedraw, { type: "deleteGen", imageIds: freed }] : withRedraw;
  }

  private scrollFor(g: GenState): number {
    if (g === this.displayGen) return this.scrollPx;
    const base = this.pendingScrollPx ?? this.scrollPx;
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
    const g = this.capture!.target;
    const actions: Action[] = [];
    if (g !== this.displayGen) {
      this.pushReleaseGen(g, actions);
    }
    actions.push(...this.startPipeline());
    return actions;
  }

  private drive(): Action[] {
    const capture = this.capture;
    if (!capture) return [];
    const g = capture.target;
    const actions: Action[] = [];

    if (this.displayGen !== g) {
      const promoScroll = this.scrollFor(g);
      if (this.allVisibleResident(g, promoScroll)) {
        const old = this.displayGen;
        const hadPending = this.pendingScrollPx !== null;
        this.scrollPx = promoScroll;
        this.displayGen = g;
        this.pendingScrollPx = null;
        if (hadPending) this.scrollFailed = false;
        if (this.failedGen !== null && g.gen >= this.failedGen) this.failedGen = null;
        actions.push({ type: "redraw" });
        if (old) {
          this.pushReleaseGen(old, actions);
        }
        this.pushEvict(g, this.geometry.maxResident, actions);
        this.shrinkQueueToSteady(capture);
      }
    } else if (this.takeCommitted(g)) {
      actions.push({ type: "redraw" });
      this.pushEvict(g, this.geometry.maxResident, actions);
      this.shrinkQueueToSteady(capture);
    }

    if (capture.inFlight) return actions;
    const next = this.nextShoot(capture);
    if (next === null) {
      if (this.displayGen === g && this.pendingScrollPx === null) this.capture = null;
      else this.settleStalled(g, actions);
      return actions;
    }
    const old = this.displayGen !== g ? this.displayGen : null;
    if (old) this.pushEvict(old, this.geometry.maxTotalResident - g.resident.size - 1, actions);
    // Reserve decoded storage before the transfer lands.
    const newBudget =
      Math.min(this.residentLimit, this.geometry.maxTotalResident - (old?.resident.size ?? 0)) - 1;
    this.pushEvict(g, newBudget, actions);
    let fits = g.resident.size <= newBudget;
    if (!fits && this.geometry.exceedsStorage && old) {
      // Single-generation mode: drop the old display instead of overflowing storage.
      this.pushReleaseGen(old, actions);
      this.displayGen = null;
      fits = g.resident.size + 1 <= this.geometry.maxResident;
    }
    if (fits) {
      capture.inFlight = true;
      actions.push(this.shootAction(g, next));
    } else {
      this.settleStalled(g, actions);
    }
    return actions;
  }

  private pushReleaseGen(g: GenState, actions: Action[]): void {
    const ids = Array.from(g.resident, (i) => imageId(g.gen, i));
    if (ids.length) actions.push({ type: "deleteGen", imageIds: ids });
    actions.push({ type: "releaseGen", gen: g.gen });
  }

  private pushEvict(g: GenState, maxSize: number, actions: Action[]): void {
    const freed = this.evictToSize(g, maxSize);
    if (freed.length) actions.push({ type: "deleteGen", imageIds: freed });
  }

  private resumePendingDisplay(actions: Action[]): boolean {
    const shown = this.displayGen;
    const pend = shown ? this.clampPendingToGen(shown) : null;
    if (!shown || pend === null) return false;
    if (this.takeCommitted(shown)) {
      actions.push({ type: "redraw" });
      actions.push(...this.startPrefetchIfNeeded(0));
      return true;
    }
    actions.push({ type: "redraw" });
    actions.push(...this.beginFetch(shown, pend, this.geometry.maxTotalResident, 0));
    return true;
  }

  private failDisplayedGen(g: GenState, actions: Action[]): void {
    if (this.pendingScrollPx !== null) this.scrollFailed = true;
    this.pendingScrollPx = null;
    this.capture = null;
    actions.push({ type: "redraw" });
    this.pushEvict(g, this.geometry.maxResident, actions);
    if (this.rerun) actions.push(...this.startPipeline());
  }

  // Leave rendering on shortage so a later update/resize can retry.
  private settleStalled(g: GenState, actions: Action[]): void {
    if (g === this.displayGen) {
      this.failDisplayedGen(g, actions);
      return;
    }
    this.pushReleaseGen(g, actions);
    this.capture = null;
    if (this.resumePendingDisplay(actions)) return;
    actions.push({ type: "redraw" });
  }

  private nextShoot(capture: Capture): number | null {
    while (capture.queue.length) {
      const i = capture.queue.shift()!;
      if (!capture.target.resident.has(i)) return i;
    }
    return null;
  }

  private shootAction(g: GenState, tileIndex: number): Action {
    return { type: "shoot", gen: g.gen, tileIndex, tile: g.tiles[tileIndex]! };
  }

  private allVisibleResident(g: GenState, scroll: number): boolean {
    return this.visibleSet(g, scroll).isSubsetOf(g.resident);
  }
}
