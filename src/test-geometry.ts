import { resolveGeometry, type Geometry } from "./geometry.ts";

export const GEO: Geometry = resolveGeometry({ cols: 80, rows: 51 }, { cellHpx: 20, cellWpx: 10 }, {
  frameBytes: null,
  storageBytes: 320_000_000,
});
