import { describe, expect, test } from "bun:test";
import { transferSize } from "./kitty.ts";
import {
  ARTICLE_MAX_WIDTH_CSS,
  CELL_CSS_PX,
  FULL_SCALE,
  captureGridCss,
  maxSliceImagePx,
  GUTTER_COLS,
  detectGraphicsLimits,
  resolveGeometry,
  sameRaster,
  screenImageBytes,
  type Geometry,
} from "./geometry.ts";

const direct = detectGraphicsLimits({});
const relayed = detectGraphicsLimits({ HERDR_ENV: "1" });

function sliceImageHeight(g: Geometry): number {
  return maxSliceImagePx(g.raster.sliceRows * CELL_CSS_PX, g.raster);
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
  test("16 CSS px span one cell, and a pane narrower than the article fills every column right of the gutter", () => {
    const g = resolveGeometry({ cols: 120, rows: 40 }, { cellHpx: 28, cellWpx: 14 }, direct);
    expect(g.raster.renderScale).toBe(FULL_SCALE);
    expect(g.deviceScaleFactor).toBe(28 / CELL_CSS_PX);
    expect(g.raster.contentCols).toBe(120 - GUTTER_COLS);
    expect(g.marginCols).toBe(0);
    expect(g.imgWidthPx).toBe((120 - GUTTER_COLS) * 14);
    expect(g.viewportWidthCssPx * g.deviceScaleFactor).toBeGreaterThanOrEqual(g.imgWidthPx);
    expect(g.viewRows).toBe(39);
  });

  test("a pane wider than the article captures only the article, centered in the columns left over", () => {
    const g = resolveGeometry({ cols: 300, rows: 40 }, { cellHpx: 28, cellWpx: 14 }, direct);
    expect(g.raster.contentCols).toBe(123);
    expect(g.marginCols).toBe(Math.floor((300 - GUTTER_COLS - 123) / 2));
    expect(g.imgWidthPx).toBe(123 * 14);
    expect(g.viewportWidthCssPx).toBeGreaterThanOrEqual(ARTICLE_MAX_WIDTH_CSS);
    expect((122 * 14 * CELL_CSS_PX) / 28).toBeLessThan(ARTICLE_MAX_WIDTH_CSS);
  });

  test("every full-window pane of a laptop or 4K screen keeps full resolution on the relay", () => {
    for (const [widthPx, heightPx] of [[2560, 1664], [2940, 1912], [3420, 2224], [3840, 2160]] as const) {
      for (let cellHpx = 24; cellHpx <= 36; cellHpx++) {
        const cellWpx = Math.round(cellHpx / 2);
        const screen = { cols: Math.floor(widthPx / cellWpx), rows: Math.floor(heightPx / cellHpx) };
        const g = resolveGeometry(screen, { cellHpx, cellWpx }, relayed);
        expect(g.raster.renderScale).toBe(FULL_SCALE);
      }
    }
  });

  test("the tallest slice that still fits one screenshot with its page around it", () => {
    const g = resolveGeometry({ cols: 120, rows: 40 }, { cellHpx: 28, cellWpx: 14 }, direct);
    expect(sliceImageHeight(g)).toBeLessThanOrEqual(4096);
    expect(maxSliceImagePx((g.raster.sliceRows + 1) * CELL_CSS_PX, g.raster)).toBeGreaterThan(4096);
  });

  test("on the relay, a slice fits one frame and only a screen too large for full resolution drops it", () => {
    const small = resolveGeometry({ cols: 80, rows: 24 }, { cellHpx: 20, cellWpx: 10 }, relayed);
    expect(small.raster.renderScale).toBe(FULL_SCALE);
    const large = resolveGeometry({ cols: 400, rows: 120 }, { cellHpx: 40, cellWpx: 20 }, relayed);
    expect(large.raster.renderScale).toBeLessThan(FULL_SCALE);
    for (const g of [small, large]) {
      expect(transferSize(g.imgWidthPx * sliceImageHeight(g) * 4)).toBeLessThanOrEqual(relayed.frameBytes!);
    }
  });

  test("full resolution whenever a screen fits, with the tallest slices that let it", () => {
    const need = (g: Geometry) => screenImageBytes(g.imgWidthPx, g.raster, g.viewRows);
    for (const [cols, rows, limits] of [[120, 50, direct], [300, 80, direct], [120, 40, relayed], [160, 50, relayed], [200, 60, relayed]] as const) {
      const g = resolveGeometry({ cols, rows }, { cellHpx: 28, cellWpx: 14 }, limits);
      expect(g.raster.renderScale).toBe(FULL_SCALE);
      expect(need(g)).toBeLessThanOrEqual(limits.storageBytes);
      const taller = { ...g, raster: { ...g.raster, sliceRows: g.raster.sliceRows + 2 } };
      const tallerFits =
        need(taller) <= limits.storageBytes &&
        sliceImageHeight(taller) <= 4096 &&
        (limits.frameBytes === null || transferSize(g.imgWidthPx * sliceImageHeight(taller) * 4) <= limits.frameBytes);
      expect(tallerFits).toBe(false);
    }
    const huge = resolveGeometry({ cols: 300, rows: 130 }, { cellHpx: 32, cellWpx: 16 }, relayed);
    expect(huge.raster.renderScale).toBe(0.5);
    expect(need(huge)).toBeLessThanOrEqual(relayed.storageBytes);
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

  test("a resize that only moves the margins around the article keeps the raster", () => {
    for (const limits of [direct, relayed]) {
      const wide = resolveGeometry({ cols: 200, rows: 40 }, { cellHpx: 28, cellWpx: 14 }, limits);
      const wider = resolveGeometry({ cols: 300, rows: 40 }, { cellHpx: 28, cellWpx: 14 }, limits);
      expect(sameRaster(wide.raster, wider.raster)).toBe(true);
      expect(wider.marginCols).toBeGreaterThan(wide.marginCols);
    }
  });

  test("a zero-column screen still captures a positive width", () => {
    const g = resolveGeometry({ cols: 0, rows: 10 }, { cellHpx: 20, cellWpx: 10 }, direct);
    expect(g.imgWidthPx).toBeGreaterThan(0);
    expect(g.viewportWidthCssPx).toBeGreaterThan(0);
  });
});
