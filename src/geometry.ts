import { transferSize } from "./kitty.ts";

export interface GraphicsLimits {
  frameBytes: number | null;
  storageBytes: number;
}

export interface CellSize {
  cellHpx: number;
  cellWpx: number;
}

export interface ScreenSize {
  cols: number;
  rows: number;
}

interface CapturePlan {
  /** Image px per terminal px. */
  renderScale: number;
  imgWidthPx: number;
  tileHeightPx: number;
  exceedsFrameLimit: boolean;
  /** One image fits transfer but old+new visible tiles do not fit storage. */
  exceedsStorage: boolean;
  maxResident: number;
  maxTotalResident: number;
}

export interface Geometry extends ScreenSize, CapturePlan {
  cellHpx: number;
  viewportWidthCssPx: number;
  /** Image px per CSS px. */
  deviceScaleFactor: number;
}

interface TileOption {
  renderScale: number;
  imgWidthPx: number;
  tileHeightPx: number;
  tilesInFrame: number;
  tileBytes: number;
  fitsFrame: boolean;
}

export type ScrollDirection = -1 | 0 | 1;

export interface Tile {
  topPx: number;
  heightPx: number;
}

interface TileLayout {
  tiles: Tile[];
  truncated: boolean;
  contentHeightPx: number;
}

interface Placement {
  tileIndex: number;
  sourceTopPx: number;
  sourceHeightPx: number;
  destinationRow: number;
  destinationRows: number;
}

/**
 * CSS px spanned by one cell's height. GitHub's 16px body text then follows the terminal
 * font size, and a power of two keeps the device scale factor exact.
 */
const CELL_CSS_PX = 16;

/** Bounds capture cost and stays below IMAGE_ID_GENERATION_STRIDE. */
const MAX_TILES = 128;

// Terminal rows are unbounded, so cap screenshot requests independently of kitty limits.
const MAX_TILE_PX = 4096;

export const FULL_SCALE = 1;
const REDUCED_SCALE = 0.5;

const HERDR_RELAY: GraphicsLimits = {
  frameBytes: 32 * 1024 * 1024 - 2 * 1024 * 1024,
  storageBytes: 64 * 1024 * 1024,
};

// 320MB is the kitty protocol quota (decoded pixels, not PNG bytes).
const DIRECT: GraphicsLimits = { frameBytes: null, storageBytes: 320_000_000 };

export function detectGraphicsLimits(env: NodeJS.ProcessEnv = process.env): GraphicsLimits {
  const v = env.HERDR_ENV;
  return v !== undefined && v !== "" && v !== "0" ? HERDR_RELAY : DIRECT;
}

/** Worst case touches one extra boundary while straddling. */
export function maxTilesInFrame(viewportHeightPx: number, tileHeightPx: number): number {
  return Math.ceil(viewportHeightPx / tileHeightPx) + 1;
}

export function fitsGraphicsFrame(
  limits: GraphicsLimits,
  imageWidthPx: number,
  tileHeightPx: number,
): boolean {
  return (
    limits.frameBytes === null ||
    transferSize(imageWidthPx * tileHeightPx * 4) <= limits.frameBytes
  );
}

function tileHeightCandidates(cellHpx: number): number[] {
  const maximum = maximumTileHeightPx(cellHpx);
  const candidates: number[] = [];
  for (let rows = Math.floor(maximum / cellHpx); rows >= 1; rows -= 2) {
    candidates.push(alignedTileHeightPx(cellHpx, rows));
  }
  return candidates;
}

/** Working set stays below terminal eviction and never below the visible floor. */
function cappedBudgets(
  tileBytes: number,
  minTiles: number,
  limits: GraphicsLimits,
): { maxResident: number; maxTotalResident: number } {
  const maxTotalResident = Math.floor(limits.storageBytes / tileBytes);
  const workingSet = Math.max(minTiles, Math.floor((limits.storageBytes * 0.8) / tileBytes));
  return { maxResident: Math.min(workingSet, maxTotalResident), maxTotalResident };
}

function tileOptions(
  screenWidthPx: number,
  viewportHeightPx: number,
  cellHpx: number,
  renderScale: number,
  limits: GraphicsLimits,
): TileOption[] {
  // At 1:1 cropping 1px is sharper than resampling the whole image.
  const imgWidthPx = toImagePx(screenWidthPx, renderScale);
  return tileHeightCandidates(cellHpx).map((tileHeightPx) => {
    const imageTileHeightPx = toImagePx(tileHeightPx, renderScale);
    return {
      renderScale,
      imgWidthPx,
      tileHeightPx,
      tilesInFrame: maxTilesInFrame(viewportHeightPx, tileHeightPx),
      tileBytes: imgWidthPx * imageTileHeightPx * 4,
      fitsFrame: fitsGraphicsFrame(limits, imgWidthPx, imageTileHeightPx),
    };
  });
}

function toPlan(option: TileOption, limits: GraphicsLimits): CapturePlan {
  const { renderScale, imgWidthPx, tileHeightPx, tilesInFrame, tileBytes } = option;
  return {
    renderScale,
    imgWidthPx,
    tileHeightPx,
    exceedsFrameLimit: !option.fitsFrame,
    exceedsStorage: 2 * tilesInFrame * tileBytes > limits.storageBytes,
    ...cappedBudgets(tileBytes, tilesInFrame + 1, limits),
  };
}

function resolveCapturePlan(
  screenWidthPx: number,
  viewportHeightPx: number,
  cellHpx: number,
  limits: GraphicsLimits,
): CapturePlan {
  const canReduce =
    limits.frameBytes !== null &&
    viewportHeightPx >= scrollUnitPx(cellHpx, REDUCED_SCALE);
  const scales = canReduce ? [FULL_SCALE, REDUCED_SCALE] : [FULL_SCALE];
  const options = scales.map((scale) =>
    tileOptions(screenWidthPx, viewportHeightPx, cellHpx, scale, limits),
  );
  const fitting = options.map((atScale) => atScale.filter((o) => o.fitsFrame));
  const visibleBytes = (o: TileOption) => o.tilesInFrame * o.tileBytes;
  const chosen =
    fitting.flat().find((o) => 2 * visibleBytes(o) <= limits.storageBytes) ??
    fitting.flat().find((o) => visibleBytes(o) <= limits.storageBytes) ??
    // Among transfer-fitting tiles, the smallest visible footprint overflows least.
    fitting
      .find((atScale) => atScale.length > 0)
      ?.reduce((best, o) => (visibleBytes(o) < visibleBytes(best) ? o : best)) ??
    // Even the smallest tile overflows one transaction; keep it to minimize the overflow.
    options.at(-1)!.at(-1)!;
  return toPlan(chosen, limits);
}

export function resolveGeometry(
  screen: ScreenSize,
  cell: CellSize,
  limits: GraphicsLimits = detectGraphicsLimits(),
): Geometry {
  const { rows } = screen;
  const cols = Math.max(1, screen.cols);
  const screenWidthPx = cols * cell.cellWpx;
  // Chrome rounds the screenshot width, so rounding up keeps it no narrower than the 1:1 crop.
  const viewportWidthCssPx = Math.ceil(toCssPx(screenWidthPx, cell.cellHpx));
  const contentRowCount = contentRows(rows);
  const viewportHeightPx = contentRowCount * cell.cellHpx;
  const plan = resolveCapturePlan(
    screenWidthPx,
    viewportHeightPx,
    cell.cellHpx,
    limits,
  );
  return {
    rows,
    cols,
    cellHpx: cell.cellHpx,
    viewportWidthCssPx,
    deviceScaleFactor: (plan.renderScale * cell.cellHpx) / CELL_CSS_PX,
    ...plan,
  };
}

export function contentRows(rows: number): number {
  return Math.max(0, rows - 1);
}

export function toImagePx(screenPx: number, renderScale: number): number {
  return Math.round(screenPx * renderScale);
}

export function toCssPx(screenPx: number, cellHpx: number): number {
  return (screenPx * CELL_CSS_PX) / cellHpx;
}

export function toScreenPx(cssPx: number, cellHpx: number): number {
  return (cssPx * cellHpx) / CELL_CSS_PX;
}

/** Odd-height downscaled cells need a two-cell scroll unit. */
export function scrollUnitPx(cellHpx: number, renderScale: number): number {
  return Number.isInteger(cellHpx * renderScale) ? cellHpx : 2 * cellHpx;
}

/** Two cells keep tile edges on whole image px at the reduced scale. */
function tileAlign(cellHpx: number): number {
  return 2 * cellHpx;
}

function maximumTileHeightPx(cellHpx: number): number {
  const unit = tileAlign(cellHpx);
  return Math.floor(MAX_TILE_PX / unit) * unit;
}

export function alignedTileHeightPx(cellHpx: number, rows: number): number {
  const unit = tileAlign(cellHpx);
  const capped = maximumTileHeightPx(cellHpx);
  const requested = Math.ceil((rows * cellHpx) / unit) * unit;
  return Math.max(unit, Math.min(requested, capped));
}

export function computeTiles(
  documentHeightPx: number,
  cellHpx: number,
  contentRows: number,
  tileHeightPx: number,
): TileLayout {
  if (contentRows <= 0) {
    return { tiles: [], truncated: false, contentHeightPx: 0 };
  }
  const unit = tileAlign(cellHpx);
  const paddedH = Math.ceil(documentHeightPx / unit) * unit;
  const tiles: Tile[] = [];
  let y = 0;
  while (y < paddedH && tiles.length < MAX_TILES) {
    const height = Math.min(tileHeightPx, paddedH - y);
    tiles.push({ topPx: y, heightPx: height });
    y += height;
  }
  const cellPadded = Math.ceil(documentHeightPx / cellHpx) * cellHpx;
  return {
    tiles,
    truncated: y < paddedH,
    contentHeightPx: Math.min(cellPadded, y),
  };
}

export function maxScrollPx(
  contentHeightPx: number,
  contentRows: number,
  cellHpx: number,
  renderScale: number,
): number {
  const unit = scrollUnitPx(cellHpx, renderScale);
  const raw = Math.ceil(Math.max(0, contentHeightPx - contentRows * cellHpx) / unit) * unit;
  // Keep at least one body image placed over the document.
  const inside = Math.max(0, Math.ceil(contentHeightPx / unit) * unit - unit);
  return Math.min(raw, inside);
}

export function clampScroll(
  scrollPx: number,
  contentHeightPx: number,
  contentRows: number,
  cellHpx: number,
  renderScale: number,
): number {
  const unit = scrollUnitPx(cellHpx, renderScale);
  const snapped = Math.round(scrollPx / unit) * unit;
  return Math.max(
    0,
    Math.min(snapped, maxScrollPx(contentHeightPx, contentRows, cellHpx, renderScale)),
  );
}

export function visibleTiles(
  scrollPx: number,
  contentRows: number,
  cellHpx: number,
  tiles: Tile[],
): Placement[] {
  const viewTop = scrollPx;
  const viewBottom = scrollPx + contentRows * cellHpx;
  const placements: Placement[] = [];
  for (let i = 0; i < tiles.length; i++) {
    const tile = tiles[i]!;
    const overlapTop = Math.max(viewTop, tile.topPx);
    const overlapBottom = Math.min(viewBottom, tile.topPx + tile.heightPx);
    if (overlapBottom <= overlapTop) continue;
    placements.push({
      tileIndex: i,
      sourceTopPx: overlapTop - tile.topPx,
      sourceHeightPx: overlapBottom - overlapTop,
      destinationRow: (overlapTop - viewTop) / cellHpx,
      destinationRows: (overlapBottom - overlapTop) / cellHpx,
    });
  }
  return placements;
}

export function backfillOrder(
  scrollPx: number,
  contentRows: number,
  cellHpx: number,
  tiles: Tile[],
  direction: ScrollDirection = 0,
): number[] {
  const center = scrollPx + (contentRows * cellHpx) / 2;
  return tiles
    .map((tile, index) => ({
      index,
      dist: Math.abs(tile.topPx + tile.heightPx / 2 - center),
    }))
    .sort((a, b) => a.dist - b.dist || direction * (b.index - a.index) || a.index - b.index)
    .map((t) => t.index);
}
