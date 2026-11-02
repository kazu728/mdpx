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
  /** Rows above the status line. */
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

/** Column left of the page for change marks. */
export const GUTTER_COLS = 1;

/** Caps one screenshot independently of the terminal's limits. */
const MAX_IMAGE_PX = 4096;

/**
 * Screenshots start and end on this CSS px grid. Puppeteer rounds a clip to whole CSS px, and
 * a multiple of one cell (two when a downscaled cell is an odd number of px) is also a whole
 * number of image px, so the image lands exactly where it was asked to.
 */
export function captureGridCss(deviceScaleFactor: number): number {
  return CELL_CSS_PX * (Number.isInteger(CELL_CSS_PX * deviceScaleFactor) ? 1 : 2);
}

/**
 * The tallest image a slice of `contentRows` rows can need: its rows rounded out to the grid
 * on both ends, plus one more grid step of page above and below.
 */
export function sliceImageRows(contentRows: number, gridRows: number): number {
  return (Math.ceil(contentRows / gridRows) + 3) * gridRows;
}

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

interface Plan {
  renderScale: number;
  imgWidthPx: number;
  sliceRows: number;
}

function planAt(
  widthPx: number,
  cellHpx: number,
  renderScale: number,
  limits: GraphicsLimits,
): Plan | null {
  const imgWidthPx = Math.max(1, Math.round(widthPx * renderScale));
  const cellImg = cellHpx * renderScale;
  // Slice edges must land on the capture grid.
  const quantum = captureGridCss((renderScale * cellHpx) / CELL_CSS_PX) / CELL_CSS_PX;
  const fits = (rows: number) => {
    const h = sliceImageRows(rows, quantum) * cellImg;
    return (
      h <= MAX_IMAGE_PX &&
      (limits.frameBytes === null || transferSize(imgWidthPx * h * 4) <= limits.frameBytes)
    );
  };
  let rows = Math.floor(MAX_IMAGE_PX / cellImg / quantum) * quantum;
  while (rows >= quantum && !fits(rows)) rows -= quantum;
  if (rows < quantum) return null;
  return { renderScale, imgWidthPx, sliceRows: rows };
}

function visibleBytes(plan: Plan, cellHpx: number, viewRows: number): number {
  return plan.imgWidthPx * ((viewRows + 2) * cellHpx * plan.renderScale) * 4;
}

function resolvePlan(
  widthPx: number,
  cellHpx: number,
  viewRows: number,
  limits: GraphicsLimits,
): Plan {
  const full = planAt(widthPx, cellHpx, FULL_SCALE, limits);
  // Only the relay is tight enough to trade resolution for room; an update holds the old
  // and the new screen at once.
  if (full && (limits.frameBytes === null || 2 * visibleBytes(full, cellHpx, viewRows) <= limits.storageBytes)) {
    return full;
  }
  return (
    planAt(widthPx, cellHpx, REDUCED_SCALE, limits) ??
    full ?? {
      // Even one row overflows a transaction; keep the smallest capture to minimize it.
      renderScale: REDUCED_SCALE,
      imgWidthPx: Math.max(1, Math.round(widthPx * REDUCED_SCALE)),
      sliceRows: 2,
    }
  );
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
