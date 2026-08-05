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
  type Tile,
} from "./viewport.ts";
import { imageId } from "./kitty.ts";

export interface Geometry {
  rows: number;
  cols: number;
  cellHpx: number;
  imgWidthPx: number;
  viewportWidthCssPx: number;
  /**
   * The screenshot's deviceScaleFactor. CSS_SCALE at 1:1. Geometries that would not fit
   * herdr's 32 MiB drop to 1, halving the image in both directions and letting kitty scale the
   * placement back up.
   */
  renderScale: number;
  /**
   * True when the geometry still exceeds herdr's relay limit after downscaling.
   */
  relayOverflow: boolean;
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
  | { type: "renderDone"; gen: number; documentHeightPx: number }
  | { type: "renderFailed"; gen: number }
  | { type: "tileReady"; gen: number; tileIndex: number };

export interface Clip {
  xCssPx: number;
  yCssPx: number;
  widthCssPx: number;
  heightCssPx: number;
}

export type Action =
  | { type: "render"; gen: number }
  | { type: "shoot"; gen: number; tileIndex: number; clip: Clip }
  | { type: "redraw" }
  | { type: "deleteGen"; imageIds: number[] };

type Phase = "rendering" | "ready";

interface ViewBase {
  geometry: Geometry;
  scrollPx: ScrollAlignedPx;
  phase: Phase;
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
    // A trigger during recapture yields to the new generation.
    if (this.pipeGen && !this.refetchingDisplayedGeneration) {
      this.rerun = true;
      return [];
    }
    return this.startPipeline();
  }

  private onResize(geometry: Geometry): Action[] {
    this.geometry = geometry;
    // Resize invalidates captured geometry; free its images before rerendering.
    const old = this.displayGen;
    this.displayGen = null;
    const actions: Action[] = [];
    if (old && old !== this.pipeGen) {
      const ids = this.residentIds(old);
      if (ids.length) actions.push({ type: "deleteGen", imageIds: ids });
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
    // Keep movement on the scroll unit so clampScroll cannot introduce drift.
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
        px = maxScrollPx(contentHeightPx, this.contentRows, cellHpx, renderScale);
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
      this.shootQueue = this.queueAround(pg, pgScroll);
      return [{ type: "redraw" }];
    }
    return [{ type: "redraw" }, ...this.refetchVisible()];
  }

  private queueAround(g: GenState, scroll: ScrollAlignedPx): number[] {
    const order = backfillOrder(scroll, this.contentRows, this.geometry.cellHpx, g.tiles);
    return order.slice(0, this.geometry.maxResident);
  }

  private refetchVisible(): Action[] {
    const g = this.displayGen;
    if (!g || this.pipeGen || g.tiles.length === 0) return [];
    if (this.allVisibleResident(g, this.scrollPx)) return [];
    this.pipeGen = g;
    this.refetchingDisplayedGeneration = true;
    this.shootQueue = this.queueAround(g, this.scrollPx);
    return this.drive();
  }

  private onRenderDone(gen: number, documentHeightPx: number): Action[] {
    const g = this.pipeGen;
    if (!g || g.gen !== gen) return [];
    if (g.invalidatedByResize) return this.abortInvalidatedGeneration();

    const { tiles, truncated, contentHeightPx } = computeTiles(
      documentHeightPx,
      this.geometry.cellHpx,
      this.contentRows,
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
    // On failure, discard unpromoted images; promoted images stay visible and are recaptured later.
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
      // A late tile for the displayed generation is still usable; otherwise delete it.
      const shown = this.displayGen;
      if (shown && shown.gen === gen) {
        shown.resident.add(tileIndex);
        const freed = this.evictBeyondBudget(shown);
        const actions: Action[] = [{ type: "redraw" }];
        if (freed.length) actions.push({ type: "deleteGen", imageIds: freed });
        return actions;
      }
      return [{ type: "deleteGen", imageIds: [imageId(gen, tileIndex)] }];
    }
    this.shootInFlight = false;
    g.resident.add(tileIndex);
    if (g.invalidatedByResize) return this.abortInvalidatedGeneration();
    const freed = this.evictBeyondBudget(g);
    const actions = this.drive();
    const withRedraw = actions[0]?.type === "redraw" ? actions : [{ type: "redraw" } as Action, ...actions];
    return freed.length ? [...withRedraw, { type: "deleteGen", imageIds: freed }] : withRedraw;
  }

  // Visible tiles are never evicted because doing so would punch a black hole in the current frame.
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

  private abortInvalidatedGeneration(): Action[] {
    // Free transferred images before replacing the invalidated generation.
    const ids = this.residentIds(this.pipeGen!);
    const actions: Action[] = ids.length ? [{ type: "deleteGen", imageIds: ids }] : [];
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
        // Place the new generation before deleting the old one to avoid a blank frame between them.
        actions.push({ type: "redraw" });
        if (old) {
          const ids = this.residentIds(old);
          if (ids.length) actions.push({ type: "deleteGen", imageIds: ids });
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
        this.refetchingDisplayedGeneration = false;
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
