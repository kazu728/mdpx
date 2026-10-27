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
  private renderFailed = false;
  private pendingScrollPx: number | null = null;
  private scrollFailed = false;
  private actions: Action[] = [];

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
        this.onTrigger();
        break;
      case "resize":
        this.onResize(event.geometry);
        break;
      case "key":
        this.onKey(event.delta);
        break;
      case "renderDone":
        this.onRenderDone(event.gen, event.documentHeightPx);
        break;
      case "renderFailed":
        this.onRenderFailed(event.gen);
        break;
      case "tileReady":
        this.onTileReady(event.gen, event.tileIndex);
        break;
    }
    const actions = this.actions;
    this.actions = [];
    return actions;
  }

  viewState(): ViewState {
    return {
      geometry: this.geometry,
      scrollPx: this.scrollPx,
      phase: this.capture?.reason === "render" ? "rendering" : "ready",
      failure: this.renderFailed || this.scrollFailed,
      pendingScrollPx: this.pendingScrollPx,
      displayGen: this.displayGen,
    };
  }

  private onTrigger(): void {
    if (this.capture?.reason === "render") this.rerun = true;
    else this.startPipeline();
  }

  private onResize(geometry: Geometry): void {
    if (sameGeometry(this.geometry, geometry)) return;
    this.geometry = geometry;
    this.pendingScrollPx = null;
    const old = this.displayGen;
    this.displayGen = null;
    if (old && old !== this.capture?.target) this.releaseGen(old);
    if (this.capture) this.rerun = true;
    else this.startPipeline();
  }

  private startPipeline(): void {
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
    };
    this.rerun = false;
    this.actions.push({ type: "render", gen: this.genCounter });
  }

  private onKey(delta: ScrollDelta): void {
    const shown = this.displayGen;
    if (!shown) return;
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
    if (this.takeCommitted(shown, direction)) return;
    const capture = this.capture;
    if (capture) {
      capture.queue = this.queueAround(
        capture.target,
        this.clampPendingToGen(capture.target)!,
        direction,
        this.geometry.maxTotalResident,
      );
    } else {
      this.beginFetch(shown, req, this.geometry.maxTotalResident, direction);
    }
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
    return [...visible, ...nearby].slice(0, limit);
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
  ): void {
    const queue = this.queueAround(g, scroll, direction, limit);
    if (queue.every((tileIndex) => g.resident.has(tileIndex))) return;
    this.capture = { target: g, reason: "refetch", queue };
    this.drive(this.capture);
  }

  private takeCommitted(g: GenState, direction: ScrollDirection = 0): boolean {
    const pend = this.clampPendingToGen(g);
    if (pend === null || !this.allVisibleResident(g, pend)) return false;
    this.scrollPx = pend;
    this.pendingScrollPx = null;
    this.scrollFailed = false;
    this.resumeSteady(direction);
    return true;
  }

  private promote(g: GenState): void {
    const scroll = this.scrollFor(g);
    if (!this.allVisibleResident(g, scroll)) return;
    const old = this.displayGen;
    this.scrollFailed = false;
    this.scrollPx = scroll;
    this.displayGen = g;
    this.pendingScrollPx = null;
    this.renderFailed = false;
    if (old) this.releaseGen(old);
    this.resumeSteady(0);
  }

  private resumeSteady(direction: ScrollDirection): void {
    const shown = this.displayGen!;
    this.evict(shown, this.geometry.maxResident);
    const capture = this.capture;
    if (!capture) {
      this.beginFetch(shown, this.scrollPx, this.geometry.maxResident, direction);
      return;
    }
    capture.queue = this.queueAround(
      capture.target,
      this.scrollFor(capture.target),
      direction,
      this.geometry.maxResident,
    );
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

  private onRenderDone(gen: number, documentHeightPx: number): void {
    const capture = this.capture;
    if (!capture || capture.target.gen !== gen) return;
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
    this.drive(capture);
  }

  private onRenderFailed(gen: number): void {
    const g = this.capture?.target;
    if (!g || g.gen !== gen) return;
    if (this.displayGen !== g) this.renderFailed = true;
    if (this.rerun) this.abortStalePipeline();
    else this.settleStalled(g);
  }

  private onTileReady(gen: number, tileIndex: number): void {
    const capture = this.capture;
    if (!capture || capture.target.gen !== gen) {
      const shown = this.displayGen;
      if (shown && shown.gen === gen) {
        shown.resident.add(tileIndex);
        this.takeCommitted(shown);
        this.evict(shown, this.residentLimit);
        return;
      }
      this.actions.push({ type: "deleteGen", imageIds: [imageId(gen, tileIndex)] });
      return;
    }
    const g = capture.target;
    g.resident.add(tileIndex);
    if (this.rerun) return this.abortStalePipeline();
    this.evict(g, this.residentLimit);
    this.drive(capture);
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

  private abortStalePipeline(): void {
    const g = this.capture!.target;
    if (g !== this.displayGen) this.releaseGen(g);
    this.startPipeline();
  }

  private drive(capture: Capture): void {
    const g = capture.target;
    if (this.displayGen === g) this.takeCommitted(g);
    else this.promote(g);

    const next = this.nextShoot(capture);
    if (next === null) {
      if (this.displayGen === g && this.pendingScrollPx === null) this.capture = null;
      else this.settleStalled(g);
      return;
    }
    const old = this.displayGen !== g ? this.displayGen : null;
    if (old) this.evict(old, this.geometry.maxTotalResident - g.resident.size - 1);
    // Reserve decoded storage before the transfer lands.
    const newBudget =
      Math.min(this.residentLimit, this.geometry.maxTotalResident - (old?.resident.size ?? 0)) - 1;
    this.evict(g, newBudget);
    if (g.resident.size <= newBudget) {
      this.actions.push({ type: "shoot", gen: g.gen, tileIndex: next, tile: g.tiles[next]! });
    } else {
      this.settleStalled(g);
    }
  }

  private releaseGen(g: GenState): void {
    const ids = Array.from(g.resident, (i) => imageId(g.gen, i));
    if (ids.length) this.actions.push({ type: "deleteGen", imageIds: ids });
    this.actions.push({ type: "releaseGen", gen: g.gen });
  }

  private evict(g: GenState, maxSize: number): void {
    if (g.resident.size <= maxSize) return;
    const visible = this.protectedSet(g);
    const order = backfillOrder(this.scrollFor(g), this.contentRows, this.geometry.cellHpx, g.tiles);
    const freed: number[] = [];
    for (let i = order.length - 1; i >= 0 && g.resident.size > maxSize; i--) {
      const tileIndex = order[i]!;
      if (!g.resident.has(tileIndex) || visible.has(tileIndex)) continue;
      g.resident.delete(tileIndex);
      freed.push(imageId(g.gen, tileIndex));
    }
    if (freed.length) this.actions.push({ type: "deleteGen", imageIds: freed });
  }

  // Leave rendering on shortage so a later update/resize can retry.
  private settleStalled(g: GenState): void {
    this.capture = null;
    const shown = this.displayGen;
    if (g === shown) {
      if (this.pendingScrollPx !== null) this.scrollFailed = true;
      this.pendingScrollPx = null;
      this.evict(g, this.geometry.maxResident);
      return;
    }
    this.releaseGen(g);
    const pend = shown ? this.clampPendingToGen(shown) : null;
    if (!shown || pend === null) return;
    if (!this.takeCommitted(shown)) this.beginFetch(shown, pend, this.geometry.maxTotalResident, 0);
  }

  private nextShoot(capture: Capture): number | null {
    while (capture.queue.length) {
      const i = capture.queue.shift()!;
      if (!capture.target.resident.has(i)) return i;
    }
    return null;
  }

  private allVisibleResident(g: GenState, scroll: number): boolean {
    return this.visibleSet(g, scroll).isSubsetOf(g.resident);
  }
}
