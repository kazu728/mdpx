import {
  alignedTileHeightPx,
  CSS_SCALE,
  contentRows,
  maximumTileHeightPx,
  scrollUnitPx,
  toImagePx,
} from "./viewport.ts";
import { transferSize } from "./kitty.ts";

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

export interface CellSize {
  cellHpx: number;
  cellWpx: number;
}

export interface ScreenSize {
  cols: number;
  rows: number;
}

interface CapturePlan {
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

interface TileOption {
  renderScale: number;
  imgWidthPx: number;
  tileHeightPx: number;
  tilesInFrame: number;
  tileBytes: number;
  fitsFrame: boolean;
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

const REDUCED_SCALE = 1;

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
  const viewportWidthCssPx = Math.round(screenWidthPx / CSS_SCALE);
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
    ...plan,
  };
}
