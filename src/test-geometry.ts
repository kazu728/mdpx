import { alignedTileHeightPx, type Geometry } from "./geometry.ts";

export const GEO: Geometry = {
  rows: 51,
  cols: 80,
  cellHpx: 10,
  imgWidthPx: 800,
  viewportWidthCssPx: 1280,
  deviceScaleFactor: 0.625,
  renderScale: 1,
  tileHeightPx: alignedTileHeightPx(10, 50),
  maxResident: 64,
  maxTotalResident: 128,
};
