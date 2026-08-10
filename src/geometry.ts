import {
  detectGraphicsLimits,
  fitsGraphicsFrame,
  maxResidentTiles,
  maxTilesInFrame,
  residentTileCapacity,
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
  maxResident: number;
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
  maxResident: number;
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
 * Prefers the tallest tile that leaves storage for one read-ahead tile, and falls back to the
 * tallest tile that merely fits a frame — fewer, taller tiles cost less to capture and place.
 */
function capturePlanAtScale(
  screenWidthPx: number,
  viewportHeightPx: number,
  cellHpx: number,
  renderScale: number,
  limits: GraphicsLimits,
): CapturePlan | null {
  const imgWidthPx = toImagePx(screenWidthPx, renderScale);
  let withoutReadAhead: CapturePlan | null = null;
  for (const tileHeightPx of tileHeightCandidates(cellHpx)) {
    const imageTileHeightPx = toImagePx(tileHeightPx, renderScale);
    const tilesInFrame = maxTilesInFrame(viewportHeightPx, tileHeightPx);
    if (!fitsGraphicsFrame(limits, imgWidthPx, imageTileHeightPx, tilesInFrame)) continue;
    const tileBytes = imgWidthPx * imageTileHeightPx * 4;
    const visibleTileFloor = tilesInFrame + 1;
    const plan: CapturePlan = {
      renderScale,
      tileHeightPx,
      exceedsFrameLimit: false,
      maxResident: maxResidentTiles(tileBytes, limits, visibleTileFloor),
    };
    if (residentTileCapacity(tileBytes, limits) >= visibleTileFloor + 1) return plan;
    withoutReadAhead ??= plan;
  }
  return withoutReadAhead;
}

function resolveCapturePlan(
  screenWidthPx: number,
  viewportHeightPx: number,
  contentRowCount: number,
  cellHpx: number,
  limits: GraphicsLimits,
): CapturePlan {
  const fullResolution = capturePlanAtScale(
    screenWidthPx,
    viewportHeightPx,
    cellHpx,
    CSS_SCALE,
    limits,
  );
  if (fullResolution) return fullResolution;

  const canReduce =
    limits.frameBytes !== null &&
    viewportHeightPx >= scrollUnitPx(cellHpx, REDUCED_SCALE);
  if (canReduce) {
    const reduced = capturePlanAtScale(
      screenWidthPx,
      viewportHeightPx,
      cellHpx,
      REDUCED_SCALE,
      limits,
    );
    if (reduced) return reduced;
  }

  const renderScale = canReduce ? REDUCED_SCALE : CSS_SCALE;
  const tileHeightPx = alignedTileHeightPx(cellHpx, contentRowCount);
  const imgWidthPx = toImagePx(screenWidthPx, renderScale);
  const imageTileHeightPx = toImagePx(tileHeightPx, renderScale);
  const tilesInFrame = maxTilesInFrame(viewportHeightPx, tileHeightPx);
  return {
    renderScale,
    tileHeightPx,
    exceedsFrameLimit: true,
    maxResident: maxResidentTiles(
      imgWidthPx * imageTileHeightPx * 4,
      limits,
      tilesInFrame + 1,
    ),
  };
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
    contentRowCount,
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
