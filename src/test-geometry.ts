import { alignedTileHeightPx, type Geometry } from "./geometry.ts";

export const GEO: Geometry = {
  rows: 51,
  cols: 80,
  cellHpx: 10,
  imgWidthPx: 800,
  viewportWidthCssPx: 400,
  renderScale: 2,
  tileHeightPx: alignedTileHeightPx(10, 50),
  exceedsFrameLimit: false,
  exceedsStorage: false,
  maxResident: 64,
  maxTotalResident: 128,
};
