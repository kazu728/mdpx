import {
  alignedTileHeightPx,
  CSS_SCALE,
  contentRows,
  maximumTileHeightPx,
  REDUCED_SCALE,
  scrollUnitPx,
  toImagePx,
} from "./viewport.ts";

export interface GraphicsLimits {
  frameBytes: number | null;
  storageBytes: number;
}

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

const KITTY_CHUNK_BYTES = 3072;

function transferSize(dataLenBytes: number): number {
  return (
    Math.ceil(dataLenBytes / 3) * 4 + Math.ceil(dataLenBytes / KITTY_CHUNK_BYTES) * 16 + 1024
  );
}

function tileCount(storageBytes: number, tileBytes: number): number {
  return Math.floor(storageBytes / Math.max(1, tileBytes));
}

export function totalTileCapacity(tileBytes: number, limits: GraphicsLimits): number {
  return tileCount(limits.storageBytes, tileBytes);
}

/** Working set stays below terminal eviction and never below the visible floor. */
export function maxResidentTiles(
  tileBytes: number,
  limits: GraphicsLimits,
  minTiles: number,
): number {
  return Math.max(minTiles, tileCount(limits.storageBytes * 0.8, tileBytes));
}

/** Worst case touches one extra boundary while straddling. */
export function maxTilesInFrame(viewportHeightPx: number, tileHeightPx: number): number {
  return Math.max(1, Math.ceil(viewportHeightPx / Math.max(1, tileHeightPx)) + 1);
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

export interface CellSize {
  cellHpx: number;
  cellWpx: number;
}

export interface ScreenSize {
  cols: number;
  rows: number;
}

export interface Geometry extends ScreenSize {
  cellHpx: number;
  imgWidthPx: number;
  viewportWidthCssPx: number;
  renderScale: number;
  tileHeightPx: number;
  exceedsFrameLimit: boolean;
  /** One image fits transfer but old+new visible tiles do not fit storage. */
  exceedsStorage: boolean;
  maxResident: number;
  maxTotalResident: number;
}

export interface Clip {
  xCssPx: number;
  yCssPx: number;
  widthCssPx: number;
  heightCssPx: number;
}

interface CapturePlan {
  renderScale: number;
  tileHeightPx: number;
  exceedsFrameLimit: boolean;
  exceedsStorage: boolean;
  maxResident: number;
  maxTotalResident: number;
}

function tileHeightCandidates(cellHpx: number): number[] {
  const maximum = maximumTileHeightPx(cellHpx);
  const candidates: number[] = [];
  for (let rows = Math.floor(maximum / cellHpx); rows >= 1; rows -= 2) {
    candidates.push(alignedTileHeightPx(cellHpx, rows));
  }
  return candidates;
}

function cappedBudgets(
  tileBytes: number,
  minTiles: number,
  limits: GraphicsLimits,
): { maxResident: number; maxTotalResident: number } {
  const maxTotalResident = totalTileCapacity(tileBytes, limits);
  return {
    maxResident: Math.min(maxResidentTiles(tileBytes, limits, minTiles), maxTotalResident),
    maxTotalResident,
  };
}

interface FittingTile {
  tileHeightPx: number;
  tilesInFrame: number;
  tileBytes: number;
}

function fittingTiles(
  screenWidthPx: number,
  viewportHeightPx: number,
  cellHpx: number,
  renderScale: number,
  limits: GraphicsLimits,
): FittingTile[] {
  const imgWidthPx = toImagePx(screenWidthPx, renderScale);
  const out: FittingTile[] = [];
  for (const tileHeightPx of tileHeightCandidates(cellHpx)) {
    const tilesInFrame = maxTilesInFrame(viewportHeightPx, tileHeightPx);
    const imageTileHeightPx = toImagePx(tileHeightPx, renderScale);
    if (!fitsGraphicsFrame(limits, imgWidthPx, imageTileHeightPx)) continue;
    out.push({ tileHeightPx, tilesInFrame, tileBytes: imgWidthPx * imageTileHeightPx * 4 });
  }
  return out;
}

function planAtScale(
  screenWidthPx: number,
  viewportHeightPx: number,
  cellHpx: number,
  renderScale: number,
  limits: GraphicsLimits,
  generations: 1 | 2,
): CapturePlan | null {
  for (const { tileHeightPx, tilesInFrame, tileBytes } of fittingTiles(
    screenWidthPx,
    viewportHeightPx,
    cellHpx,
    renderScale,
    limits,
  )) {
    if (generations * tilesInFrame * tileBytes > limits.storageBytes) continue;
    return {
      renderScale,
      tileHeightPx,
      exceedsFrameLimit: false,
      exceedsStorage: generations !== 2,
      ...cappedBudgets(tileBytes, tilesInFrame + 1, limits),
    };
  }
  return null;
}

/** Among transfer-fitting tiles, the smallest visible footprint overflows least. */
function transferBestAtScale(
  screenWidthPx: number,
  viewportHeightPx: number,
  cellHpx: number,
  renderScale: number,
  limits: GraphicsLimits,
): CapturePlan | null {
  let best: CapturePlan | null = null;
  let bestSingleBytes = Number.POSITIVE_INFINITY;
  for (const { tileHeightPx, tilesInFrame, tileBytes } of fittingTiles(
    screenWidthPx,
    viewportHeightPx,
    cellHpx,
    renderScale,
    limits,
  )) {
    const singleBytes = tilesInFrame * tileBytes;
    if (singleBytes >= bestSingleBytes) continue;
    bestSingleBytes = singleBytes;
    best = {
      renderScale,
      tileHeightPx,
      exceedsFrameLimit: false,
      exceedsStorage: true,
      ...cappedBudgets(tileBytes, tilesInFrame + 1, limits),
    };
  }
  return best;
}

function smallestPlanAtScale(
  screenWidthPx: number,
  viewportHeightPx: number,
  cellHpx: number,
  renderScale: number,
  limits: GraphicsLimits,
): CapturePlan {
  const candidates = tileHeightCandidates(cellHpx);
  const tileHeightPx = candidates[candidates.length - 1]!;
  const imgWidthPx = toImagePx(screenWidthPx, renderScale);
  const imageTileHeightPx = toImagePx(tileHeightPx, renderScale);
  const tilesInFrame = maxTilesInFrame(viewportHeightPx, tileHeightPx);
  const tileBytes = imgWidthPx * imageTileHeightPx * 4;
  return {
    renderScale,
    tileHeightPx,
    exceedsFrameLimit: !fitsGraphicsFrame(limits, imgWidthPx, imageTileHeightPx),
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
  const scales = canReduce ? [CSS_SCALE, REDUCED_SCALE] : [CSS_SCALE];
  for (const scale of scales) {
    const both = planAtScale(screenWidthPx, viewportHeightPx, cellHpx, scale, limits, 2);
    if (both) return both;
  }
  for (const scale of scales) {
    const single = planAtScale(screenWidthPx, viewportHeightPx, cellHpx, scale, limits, 1);
    if (single) return single;
  }
  for (const scale of scales) {
    const best = transferBestAtScale(screenWidthPx, viewportHeightPx, cellHpx, scale, limits);
    if (best) return best;
  }
  // Even the smallest tile overflows one transaction; keep it to minimize the overflow.
  return smallestPlanAtScale(
    screenWidthPx,
    viewportHeightPx,
    cellHpx,
    canReduce ? REDUCED_SCALE : CSS_SCALE,
    limits,
  );
}

export function resolveGeometry(
  screen: ScreenSize,
  cell: CellSize,
  limits: GraphicsLimits = detectGraphicsLimits(),
): Geometry {
  const { cols, rows } = screen;
  const screenWidthPx = cols * cell.cellWpx;
  const viewportWidthCssPx = Math.round(screenWidthPx / CSS_SCALE);
  const contentRowCount = contentRows(rows);
  const viewportHeightPx = contentRowCount * cell.cellHpx;
  const plan = resolveCapturePlan(
    screenWidthPx,
    viewportHeightPx,
    cell.cellHpx,
    limits,
  );
  // At 1:1 cropping 1px is sharper than resampling the whole image.
  const imgWidthPx = toImagePx(screenWidthPx, plan.renderScale);
  return {
    rows,
    cols,
    cellHpx: cell.cellHpx,
    imgWidthPx,
    viewportWidthCssPx,
    ...plan,
  };
}
