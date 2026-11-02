import { describe, expect, test } from "bun:test";
import { transferSize } from "./kitty.ts";
import {
  CELL_CSS_PX,
  FULL_SCALE,
  captureGridCss,
  sliceImageRows,
  GUTTER_COLS,
  detectGraphicsLimits,
  resolveGeometry,
  sameRaster,
  type Geometry,
} from "./geometry.ts";

const direct = detectGraphicsLimits({});
const relayed = detectGraphicsLimits({ HERDR_ENV: "1" });

/** The tallest image a full slice can need (see sliceImageRows). */
function sliceImageHeight(g: Geometry): number {
  const gridRows = captureGridCss(g.deviceScaleFactor) / CELL_CSS_PX;
  return sliceImageRows(g.raster.sliceRows, gridRows) * g.raster.cellHpx * g.raster.renderScale;
}

describe("detectGraphicsLimits", () => {
  test("HERDR_ENV turns on the relay limits unless it is empty or 0", () => {
    const limited = (env: NodeJS.ProcessEnv) => detectGraphicsLimits(env).frameBytes !== null;
    expect(limited({ HERDR_ENV: "1" })).toBe(true);
    expect(limited({ HERDR_ENV: "" })).toBe(false);
    expect(limited({ HERDR_ENV: "0" })).toBe(false);
    expect(limited({})).toBe(false);
  });
});

describe("resolveGeometry", () => {
  test("16 CSS px span one cell, and the page fills every column right of the gutter", () => {
    const g = resolveGeometry({ cols: 120, rows: 40 }, { cellHpx: 28, cellWpx: 14 }, direct);
    expect(g.raster.renderScale).toBe(FULL_SCALE);
    expect(g.deviceScaleFactor).toBe(28 / CELL_CSS_PX);
    expect(g.raster.contentCols).toBe(120 - GUTTER_COLS);
    expect(g.imgWidthPx).toBe((120 - GUTTER_COLS) * 14);
    expect(g.viewportWidthCssPx * g.deviceScaleFactor).toBeGreaterThanOrEqual(g.imgWidthPx);
    expect(g.viewRows).toBe(39);
  });

  test("the tallest slice that still fits one screenshot with its page around it", () => {
    const g = resolveGeometry({ cols: 120, rows: 40 }, { cellHpx: 28, cellWpx: 14 }, direct);
    expect(sliceImageHeight(g)).toBeLessThanOrEqual(4096);
    expect(sliceImageRows(g.raster.sliceRows + 1, 1) * 28).toBeGreaterThan(4096);
  });

  test("on the relay, a slice fits one frame and large screens trade resolution for room", () => {
    const small = resolveGeometry({ cols: 80, rows: 24 }, { cellHpx: 20, cellWpx: 10 }, relayed);
    expect(small.raster.renderScale).toBe(FULL_SCALE);
    const large = resolveGeometry({ cols: 400, rows: 120 }, { cellHpx: 40, cellWpx: 20 }, relayed);
    expect(large.raster.renderScale).toBeLessThan(FULL_SCALE);
    for (const g of [small, large]) {
      expect(transferSize(g.imgWidthPx * sliceImageHeight(g) * 4)).toBeLessThanOrEqual(relayed.frameBytes!);
    }
  });

  test("downscaled odd cells capture on a two-row grid so image edges stay on whole px", () => {
    const g = resolveGeometry({ cols: 400, rows: 120 }, { cellHpx: 41, cellWpx: 20 }, relayed);
    expect(g.raster.renderScale).toBe(0.5);
    expect(g.raster.sliceRows % 2).toBe(0);
    expect(Number.isInteger(g.raster.sliceRows * 41 * 0.5)).toBe(true);
    expect(captureGridCss(g.deviceScaleFactor)).toBe(2 * CELL_CSS_PX);
  });

  test("a resize that changes only the rows keeps the raster, so cached images stay valid", () => {
    const a = resolveGeometry({ cols: 120, rows: 40 }, { cellHpx: 28, cellWpx: 14 }, direct);
    const taller = resolveGeometry({ cols: 120, rows: 60 }, { cellHpx: 28, cellWpx: 14 }, direct);
    const wider = resolveGeometry({ cols: 121, rows: 40 }, { cellHpx: 28, cellWpx: 14 }, direct);
    const bigger = resolveGeometry({ cols: 120, rows: 40 }, { cellHpx: 30, cellWpx: 15 }, direct);
    expect(sameRaster(a.raster, taller.raster)).toBe(true);
    expect(sameRaster(a.raster, wider.raster)).toBe(false);
    expect(sameRaster(a.raster, bigger.raster)).toBe(false);
  });

  test("a zero-column screen still captures a positive width", () => {
    const g = resolveGeometry({ cols: 0, rows: 10 }, { cellHpx: 20, cellWpx: 10 }, direct);
    expect(g.imgWidthPx).toBeGreaterThan(0);
    expect(g.viewportWidthCssPx).toBeGreaterThan(0);
  });
});
