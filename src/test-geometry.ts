import { resolveGeometry, type Geometry } from "./geometry.ts";

/** 80x51 cells of 10x20 px: 50 view rows, one gutter column, full scale, 16 CSS px = 20 px. */
export const GEO: Geometry = resolveGeometry({ cols: 80, rows: 51 }, { cellHpx: 20, cellWpx: 10 }, {
  frameBytes: null,
  storageBytes: 320_000_000,
});
