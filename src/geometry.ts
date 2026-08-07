import {
  detectGraphicsLimits,
  maxResidentTiles,
  maxTilesInFrame,
  pickRenderScale,
  type GraphicsLimits,
} from "./capacity.ts";
import {
  alignedTileHeightPx,
  CSS_SCALE,
  contentRows,
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

export function resolveGeometry(
  screen: ScreenSize,
  cell: CellSize,
  limits: GraphicsLimits = detectGraphicsLimits(),
): Geometry {
  const { cols, rows } = screen;
  const screenWidthPx = cols * cell.cellWpx;
  const viewportWidthCssPx = Math.round(screenWidthPx / CSS_SCALE);
  const viewportHeightPx = contentRows(rows) * cell.cellHpx;
  const tileHeightPx = alignedTileHeightPx(cell.cellHpx, contentRows(rows));
  const { renderScale, exceedsFrameLimit } = pickRenderScale({
    viewportWidthCssPx,
    tileHeightPx,
    viewportHeightPx,
    reducedScrollUnitPx: scrollUnitPx(cell.cellHpx, REDUCED_SCALE),
    limits,
  });
  // At 1:1 the real image can be 1 px wider than the terminal, and cropping that pixel is sharper
  // than resampling the whole image.
  const imgWidthPx = toImagePx(screenWidthPx, renderScale);
  // The terminal holds images as decoded pixels, so the amount held follows the area, not the PNG size
  const tileBytes = imgWidthPx * toImagePx(tileHeightPx, renderScale) * 4;
  return {
    rows,
    cols,
    cellHpx: cell.cellHpx,
    imgWidthPx,
    viewportWidthCssPx,
    renderScale,
    tileHeightPx,
    exceedsFrameLimit,
    maxResident: maxResidentTiles(
      tileBytes,
      limits,
      maxTilesInFrame(viewportHeightPx, tileHeightPx),
    ),
  };
}
