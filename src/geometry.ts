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

/**
 * Everything that decides the pixels of a captured image. Images captured under an equal
 * RasterSpec stay valid, so a resize that changes only the row count captures nothing.
 */
export interface RasterSpec {
  readonly contentCols: number;
  readonly cellWpx: number;
  readonly cellHpx: number;
  readonly renderScale: number;
  /** Rows of content in a full slice. Taller blocks are split. */
  readonly sliceRows: number;
}

export interface Geometry {
  readonly raster: RasterSpec;
  readonly cols: number;
  readonly rows: number;
  readonly viewRows: number;
  readonly viewportWidthCssPx: number;
  readonly deviceScaleFactor: number;
  readonly imgWidthPx: number;
  readonly storageBytes: number;
}

/**
 * CSS px spanned by one cell's height. GitHub's 16px body text then follows the terminal
 * font size. GitHub's block margins are at least this tall, which is what lets every block
 * be captured with a one-row margin of blank page.
 */
export const CELL_CSS_PX = 16;

export const GUTTER_COLS = 1;

const MAX_IMAGE_PX = 4096;

/**
 * Screenshots start and end on this CSS px grid. Puppeteer rounds a clip to whole CSS px, and
 * a multiple of one cell (two when a downscaled cell is an odd number of px) is also a whole
 * number of image px, so the image lands exactly where it was asked to.
 */
export function captureGridCss(deviceScaleFactor: number): number {
  return CELL_CSS_PX * (Number.isInteger(CELL_CSS_PX * deviceScaleFactor) ? 1 : 2);
}

/** What to screenshot for a slice: its content rounded out to the grid, plus one more grid step of page above and below. */
export function captureClipCss(
  contentTopCss: number,
  lengthCss: number,
  deviceScaleFactor: number,
): { topCss: number; bottomCss: number } {
  const grid = captureGridCss(deviceScaleFactor);
  return {
    topCss: Math.floor(contentTopCss / grid) * grid - grid,
    bottomCss: Math.ceil((contentTopCss + lengthCss) / grid) * grid + grid,
  };
}

/** The most rows `captureClipCss` can span for content of `contentRows` rows, wherever it sits on the grid. */
export function maxSliceImageRows(contentRows: number, gridRows: number): number {
  return (Math.ceil(contentRows / gridRows) + 3) * gridRows;
}

/** The tallest image a slice of `lengthCss` can have. */
export function maxSliceImagePx(lengthCss: number, raster: RasterSpec): number {
  const gridRows = captureGridCss((raster.renderScale * raster.cellHpx) / CELL_CSS_PX) / CELL_CSS_PX;
  const rows = maxSliceImageRows(Math.ceil(lengthCss / CELL_CSS_PX), gridRows);
  return Math.ceil(rows * raster.cellHpx * raster.renderScale);
}

export const FULL_SCALE = 1;
const REDUCED_SCALE = 0.5;

/** An update keeps the old screen's images until the new screen's are in. */
const SCREENS_HELD_IN_AN_UPDATE = 2;

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

interface Plan {
  renderScale: number;
  imgWidthPx: number;
  sliceRows: number;
}

/**
 * The most image bytes one screen can need: its visible rows, the hidden part of the slice cut
 * by each edge of the view, and the page captured around each visible slice. Assumes blocks at
 * least one row tall, as GitHub's are, so units start at least two rows apart.
 */
export function screenImageBytes(
  imgWidthPx: number,
  raster: Pick<RasterSpec, "cellHpx" | "renderScale" | "sliceRows">,
  viewRows: number,
): number {
  const gridRows = captureGridCss((raster.renderScale * raster.cellHpx) / CELL_CSS_PX) / CELL_CSS_PX;
  const slices = Math.ceil(viewRows / 2) + 2 + Math.floor(viewRows / raster.sliceRows);
  const rows = viewRows + 2 * raster.sliceRows + 4 * gridRows * slices;
  return imgWidthPx * Math.ceil(rows * raster.cellHpx * raster.renderScale) * 4;
}

/** Every slice height that fits one screenshot and one relay frame at this scale, tallest first. */
function plansAt(widthPx: number, cellHpx: number, renderScale: number, limits: GraphicsLimits): Plan[] {
  const imgWidthPx = Math.max(1, Math.round(widthPx * renderScale));
  const cellImg = cellHpx * renderScale;
  const quantum = captureGridCss((renderScale * cellHpx) / CELL_CSS_PX) / CELL_CSS_PX;
  const plans: Plan[] = [];
  for (let rows = Math.floor(MAX_IMAGE_PX / cellImg / quantum) * quantum; rows >= quantum; rows -= quantum) {
    const h = maxSliceImageRows(rows, quantum) * cellImg;
    if (h > MAX_IMAGE_PX) continue;
    if (limits.frameBytes !== null && transferSize(imgWidthPx * h * 4) > limits.frameBytes) continue;
    plans.push({ renderScale, imgWidthPx, sliceRows: rows });
  }
  return plans;
}

/**
 * The tallest slices at full scale that leave room for an update, then the same at reduced
 * scale (the relay only). When nothing leaves room, the plan that needs the least, so that as
 * few updates as possible have to give up.
 */
function resolvePlan(widthPx: number, cellHpx: number, viewRows: number, limits: GraphicsLimits): Plan {
  const scales = limits.frameBytes === null ? [FULL_SCALE] : [FULL_SCALE, REDUCED_SCALE];
  const need = (p: Plan) =>
    SCREENS_HELD_IN_AN_UPDATE * screenImageBytes(p.imgWidthPx, { cellHpx, renderScale: p.renderScale, sliceRows: p.sliceRows }, viewRows);
  const candidates = scales.map((scale) => plansAt(widthPx, cellHpx, scale, limits));
  for (const plans of candidates) {
    const fit = plans.find((p) => need(p) <= limits.storageBytes);
    if (fit) return fit;
  }
  const all = candidates.flat();
  if (all.length === 0) {
    // Even one row overflows a relay frame; keep the smallest capture to minimize the overflow.
    return { renderScale: REDUCED_SCALE, imgWidthPx: Math.max(1, Math.round(widthPx * REDUCED_SCALE)), sliceRows: 2 };
  }
  return all.reduce((best, p) => (need(p) < need(best) ? p : best));
}

export function resolveGeometry(
  screen: ScreenSize,
  cell: CellSize,
  limits: GraphicsLimits = detectGraphicsLimits(),
): Geometry {
  const cols = Math.max(1, screen.cols);
  const rows = Math.max(1, screen.rows);
  const viewRows = rows - 1;
  const contentCols = Math.max(1, cols - GUTTER_COLS);
  const widthPx = contentCols * cell.cellWpx;
  const plan = resolvePlan(widthPx, cell.cellHpx, viewRows, limits);
  return {
    raster: {
      contentCols,
      cellWpx: cell.cellWpx,
      cellHpx: cell.cellHpx,
      renderScale: plan.renderScale,
      sliceRows: plan.sliceRows,
    },
    cols,
    rows,
    viewRows,
    // Chrome rounds the screenshot width, so rounding up keeps it no narrower than the crop.
    viewportWidthCssPx: Math.ceil((widthPx * CELL_CSS_PX) / cell.cellHpx),
    deviceScaleFactor: (plan.renderScale * cell.cellHpx) / CELL_CSS_PX,
    imgWidthPx: plan.imgWidthPx,
    storageBytes: limits.storageBytes,
  };
}

export function sameRaster(a: RasterSpec, b: RasterSpec): boolean {
  return (Object.keys(a) as (keyof RasterSpec)[]).every((k) => a[k] === b[k]);
}
