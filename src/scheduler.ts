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
  displayGen: Readonly<GenState> | null;
}

function sameGeometry(a: Geometry, b: Geometry): boolean {
  return (Object.keys(a) as (keyof Geometry)[]).every((k) => a[k] === b[k]);
}

export class Scheduler {
  private geometry: Geometry;
  private genCounter = 0;
  private shown: GenState | null = null;
  private scrollPx = 0;
  private pendingScrollPx: number | null = null;
  private direction: ScrollDirection = 0;
  private dirty = false;
  private rendering: number | null = null;
  private next: GenState | null = null;
  private shooting = false;
  private renderFailed = false;
  private scrollFailed = false;
  private actions: Action[] = [];

  constructor(geometry: Geometry) {
    this.geometry = geometry;
  }

  private get contentRows(): number {
    return contentRows(this.geometry.rows);
  }

  dispatch(event: SchedulerEvent): Action[] {
    switch (event.type) {
      case "trigger":
        this.dirty = true;
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
        this.onFailed(event.gen);
        break;
      case "tileReady":
        this.onTileReady(event.gen, event.tileIndex);
        break;
    }
    this.reconcile();
    const actions = this.actions;
    this.actions = [];
    return actions;
  }

  viewState(): ViewState {
    return {
      geometry: this.geometry,
      scrollPx: this.scrollPx,
      phase: this.rendering !== null || this.next ? "rendering" : "ready",
      failure: this.renderFailed || this.scrollFailed,
      pendingScrollPx: this.pendingScrollPx,
      displayGen: this.shown,
    };
  }

  private onResize(geometry: Geometry): void {
    if (sameGeometry(this.geometry, geometry)) return;
    this.geometry = geometry;
    this.pendingScrollPx = null;
    if (this.shown) this.release(this.shown);
    if (this.next) this.release(this.next);
    this.shown = null;
    this.next = null;
    this.dirty = true;
  }

  private onKey(delta: ScrollDelta): void {
    const shown = this.shown;
    if (!shown) return;
    const { cellHpx, renderScale } = this.geometry;
    const unit = scrollUnitPx(cellHpx, renderScale);
    let px = this.pendingScrollPx ?? this.scrollPx;
    switch (delta.kind) {
      case "lines":
        px += delta.n * unit;
        this.direction = Math.sign(delta.n) as ScrollDirection;
        break;
      case "halfpage": {
        const half = Math.floor(this.contentRows / 2) * cellHpx;
        px += delta.dir * Math.max(unit, Math.round(half / unit) * unit);
        this.direction = delta.dir;
        break;
      }
      case "top":
        px = 0;
        this.direction = -1;
        break;
      case "bottom":
        px = maxScrollPx(shown.contentHeightPx, this.contentRows, cellHpx, renderScale);
        this.direction = 1;
        break;
    }
    this.pendingScrollPx = this.clampTo(shown, px);
    this.scrollFailed = false;
  }

  private onRenderDone(gen: number, documentHeightPx: number): void {
    this.rendering = null;
    const { cellHpx, tileHeightPx } = this.geometry;
    const layout = computeTiles(documentHeightPx, cellHpx, this.contentRows, tileHeightPx);
    this.next = { gen, ...layout, resident: new Set() };
  }

  private onFailed(gen: number): void {
    if (gen === this.rendering) {
      this.rendering = null;
      this.renderFailed = true;
      this.actions.push({ type: "releaseGen", gen });
      return;
    }
    this.shooting = false;
    const g = this.target();
    if (g?.gen === gen) this.giveUp(g);
  }

  private onTileReady(gen: number, tileIndex: number): void {
    this.shooting = false;
    const g = [this.next, this.shown].find((s) => s?.gen === gen);
    if (g) g.resident.add(tileIndex);
    else this.actions.push({ type: "deleteGen", imageIds: [imageId(gen, tileIndex)] });
  }

  private reconcile(): void {
    if (this.dirty && this.rendering === null) this.startRender();
    this.settle();
    this.fetch();
  }

  private startRender(): void {
    if (this.next) this.release(this.next);
    this.next = null;
    this.dirty = false;
    this.rendering = ++this.genCounter;
    this.actions.push({ type: "render", gen: this.rendering });
  }

  private settle(): void {
    const { shown, next, pendingScrollPx } = this;
    if (pendingScrollPx !== null && this.covers(shown!, pendingScrollPx)) {
      this.scrollPx = pendingScrollPx;
      this.pendingScrollPx = null;
    }
    if (next && this.covers(next, this.scrollFor(next))) {
      this.scrollPx = this.scrollFor(next);
      this.pendingScrollPx = null;
      this.shown = next;
      this.next = null;
      this.renderFailed = false;
      this.scrollFailed = false;
      if (shown) this.release(shown);
    }
  }

  private target(): GenState | null {
    return this.next ?? (this.rendering === null ? this.shown : null);
  }

  private fetch(): void {
    const g = this.target();
    if (!g) return;
    if (g === this.shown && this.pendingScrollPx === null) return this.prefetch(g);
    if (this.shooting || this.shootVisible(g)) return;
    this.giveUp(g);
    this.fetch();
  }

  private giveUp(g: GenState): void {
    if (g === this.next) {
      this.release(g);
      this.next = null;
      this.renderFailed = true;
    } else {
      this.pendingScrollPx = null;
      this.scrollFailed = true;
    }
  }

  private prefetch(g: GenState): void {
    const keep = this.order(g, this.scrollPx).slice(0, this.geometry.maxResident);
    this.evict(g, this.scrollPx, new Set(keep), 0);
    const missing = keep.find((i) => !g.resident.has(i));
    if (this.shooting || this.scrollFailed || missing === undefined) return;
    this.shoot(g, missing);
  }

  private shootVisible(g: GenState): boolean {
    const scroll = this.scrollFor(g);
    const need = this.visibleSet(g, scroll);
    const missing = [...need].find((i) => !g.resident.has(i))!;
    const budget = this.geometry.maxTotalResident - 1;
    const shown = this.shown;
    const placed = shown ? this.visibleSet(shown, this.scrollPx) : new Set<number>();
    const other = g === shown ? null : shown;
    if (other) this.evict(other, this.scrollPx, placed, budget - g.resident.size);
    const otherSize = other?.resident.size ?? 0;
    this.evict(g, scroll, g === shown ? need.union(placed) : need, budget - otherSize);
    if (g.resident.size + otherSize > budget) return false;
    this.shoot(g, missing);
    return true;
  }

  private shoot(g: GenState, tileIndex: number): void {
    this.shooting = true;
    this.actions.push({ type: "shoot", gen: g.gen, tileIndex, tile: g.tiles[tileIndex]! });
  }

  private evict(g: GenState, scroll: number, keep: Set<number>, maxSize: number): void {
    const order = this.order(g, scroll);
    const freed: number[] = [];
    for (let i = order.length - 1; i >= 0 && g.resident.size > maxSize; i--) {
      const tileIndex = order[i]!;
      if (!g.resident.has(tileIndex) || keep.has(tileIndex)) continue;
      g.resident.delete(tileIndex);
      freed.push(imageId(g.gen, tileIndex));
    }
    if (freed.length) this.actions.push({ type: "deleteGen", imageIds: freed });
  }

  private release(g: GenState): void {
    const ids = Array.from(g.resident, (i) => imageId(g.gen, i));
    if (ids.length) this.actions.push({ type: "deleteGen", imageIds: ids });
    this.actions.push({ type: "releaseGen", gen: g.gen });
  }

  private scrollFor(g: GenState): number {
    return this.clampTo(g, this.pendingScrollPx ?? this.scrollPx);
  }

  private clampTo(g: GenState, px: number): number {
    const { cellHpx, renderScale } = this.geometry;
    return clampScroll(px, g.contentHeightPx, this.contentRows, cellHpx, renderScale);
  }

  private order(g: GenState, scroll: number): number[] {
    const visible = this.visibleSet(g, scroll);
    const nearby = backfillOrder(scroll, this.contentRows, this.geometry.cellHpx, g.tiles, this.direction);
    return [...visible, ...nearby.filter((i) => !visible.has(i))];
  }

  private visibleSet(g: GenState, scroll: number): Set<number> {
    return new Set(
      visibleTiles(scroll, this.contentRows, this.geometry.cellHpx, g.tiles).map((p) => p.tileIndex),
    );
  }

  private covers(g: GenState, scroll: number): boolean {
    return this.visibleSet(g, scroll).isSubsetOf(g.resident);
  }
}
