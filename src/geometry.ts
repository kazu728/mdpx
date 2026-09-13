import {
  detectGraphicsLimits,
  fitsGraphicsFrame,
  maxResidentTiles,
  maxTilesInFrame,
  totalTileCapacity,
  type GraphicsLimits,
} from "./capacity.ts";
import {
  alignedTileHeightPx,
  CSS_SCALE,
  contentRows,
  maximumTileHeightPx,
  REDUCED_SCALE,
  scrollUnitPx,
  toImagePx,
  type TileAlignedPx,
} from "./viewport.ts";

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
  /** Downscaling shrinks the image in both directions; kitty scales the placement back up. */
  renderScale: number;
  tileHeightPx: TileAlignedPx;
  exceedsFrameLimit: boolean;
  /** True when one image fits transfer but old+new visible tiles do not fit storage. */
  exceedsStorage: boolean;
  maxResident: number;
  /** Bound on old+new resident tiles combined. */
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
  tileHeightPx: TileAlignedPx;
  exceedsFrameLimit: boolean;
  exceedsStorage: boolean;
  maxResident: number;
  maxTotalResident: number;
}

function tileHeightCandidates(cellHpx: number): TileAlignedPx[] {
  const maximum = maximumTileHeightPx(cellHpx);
  const candidates: TileAlignedPx[] = [];
  for (let rows = Math.floor(maximum / cellHpx); rows >= 1; rows -= 2) {
    candidates.push(alignedTileHeightPx(cellHpx, rows));
  }
  return candidates;
}

/**
 * Within one scale, capacity is mandatory and height is preference: one tile must fit the
 * transfer budget and the required generations of visible tiles must fit storage; the tallest
 * fitting tile wins, which is also the fewest tiles per screen. Candidates run tallest-first.
 * maxResident is capped to maxTotalResident so the fallback can never promise more than fits.
 */
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

function planAtScale(
  screenWidthPx: number,
  viewportHeightPx: number,
  cellHpx: number,
  renderScale: number,
  limits: GraphicsLimits,
  generations: 1 | 2,
): CapturePlan | null {
  const imgWidthPx = toImagePx(screenWidthPx, renderScale);
  for (const tileHeightPx of tileHeightCandidates(cellHpx)) {
    const tilesInFrame = maxTilesInFrame(viewportHeightPx, tileHeightPx);
    const imageTileHeightPx = toImagePx(tileHeightPx, renderScale);
    if (!fitsGraphicsFrame(limits, imgWidthPx, imageTileHeightPx)) continue;
    const tileBytes = imgWidthPx * imageTileHeightPx * 4;
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

/** Among transfer-fitting tiles, the one with the smallest visible footprint overflows least. */
function transferBestAtScale(
  screenWidthPx: number,
  viewportHeightPx: number,
  cellHpx: number,
  renderScale: number,
  limits: GraphicsLimits,
): CapturePlan | null {
  const imgWidthPx = toImagePx(screenWidthPx, renderScale);
  let best: CapturePlan | null = null;
  let bestSingleBytes = Number.POSITIVE_INFINITY;
  for (const tileHeightPx of tileHeightCandidates(cellHpx)) {
    const tilesInFrame = maxTilesInFrame(viewportHeightPx, tileHeightPx);
    const imageTileHeightPx = toImagePx(tileHeightPx, renderScale);
    if (!fitsGraphicsFrame(limits, imgWidthPx, imageTileHeightPx)) continue;
    const tileBytes = imgWidthPx * imageTileHeightPx * 4;
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
  // Prefer full resolution while it fits transfer and old+new storage; only then try reduced.
  // When old+new no longer fits, fall back to a single generation that still fits transfer:
  // the scheduler drops the old display first instead of holding both. Transfer overflow is
  // reported separately and never passed off as a storage fit.
  const fullBoth = planAtScale(screenWidthPx, viewportHeightPx, cellHpx, CSS_SCALE, limits, 2);
  if (fullBoth) return fullBoth;

  const canReduce =
    limits.frameBytes !== null &&
    viewportHeightPx >= scrollUnitPx(cellHpx, REDUCED_SCALE);
  if (canReduce) {
    const reducedBoth = planAtScale(
      screenWidthPx,
      viewportHeightPx,
      cellHpx,
      REDUCED_SCALE,
      limits,
      2,
    );
    if (reducedBoth) return reducedBoth;
  }

  const fullSingle = planAtScale(screenWidthPx, viewportHeightPx, cellHpx, CSS_SCALE, limits, 1);
  if (fullSingle) return fullSingle;
  if (canReduce) {
    const reducedSingle = planAtScale(
      screenWidthPx,
      viewportHeightPx,
      cellHpx,
      REDUCED_SCALE,
      limits,
      1,
    );
    if (reducedSingle) return reducedSingle;
  }

  const fullTransferBest = transferBestAtScale(
    screenWidthPx,
    viewportHeightPx,
    cellHpx,
    CSS_SCALE,
    limits,
  );
  if (fullTransferBest) return fullTransferBest;
  if (canReduce) {
    const reducedTransferBest = transferBestAtScale(
      screenWidthPx,
      viewportHeightPx,
      cellHpx,
      REDUCED_SCALE,
      limits,
    );
    if (reducedTransferBest) return reducedTransferBest;
  }

  // True transfer overflow: even the smallest tile does not fit one transaction.
  // Keep the smallest to minimize the overflow; budgets stay capped so maxResident <= maxTotal.
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
  // At 1:1 the real image can be 1 px wider than the terminal, and cropping that pixel is sharper
  // than resampling the whole image.
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
