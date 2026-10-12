import { describe, expect, test } from "bun:test";
import {
  alignedTileHeightPx,
  backfillOrder,
  clampScroll,
  computeTiles,
  contentRows,
  detectGraphicsLimits,
  fitsGraphicsFrame,
  maxScrollPx,
  maxTilesInFrame,
  resolveGeometry,
  toImagePx,
  type Geometry,
} from "./geometry.ts";

const CELL = { cellHpx: 31, cellWpx: 14 };
const direct = detectGraphicsLimits({});
const relayed = detectGraphicsLimits({ HERDR_ENV: "1" });

const CELL_HPX = 10;
const ROWS = 50;
const UNIT = 2 * CELL_HPX;

function layout(documentHeightPx: number, cellHpx = CELL_HPX, rows = ROWS) {
  return computeTiles(documentHeightPx, cellHpx, rows, alignedTileHeightPx(cellHpx, rows));
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

describe("fitsGraphicsFrame", () => {
  test("judges a tile by its base64 transfer size, not its raw size", () => {
    expect(fitsGraphicsFrame(relayed, 1512, 2046)).toBe(true);
    // 24MB of RGBA fits the 30MB frame raw, but not once base64 grows it by a third.
    expect(fitsGraphicsFrame(relayed, 3024, 1984)).toBe(false);
  });
});

describe("resolveGeometry", () => {
  function tileBytes(g: Geometry): number {
    return g.imgWidthPx * toImagePx(g.tileHeightPx, g.renderScale) * 4;
  }
  function visibleBytes(g: Geometry): number {
    return maxTilesInFrame(contentRows(g.rows) * g.cellHpx, g.tileHeightPx) * tileBytes(g);
  }

  test("picks the tallest tile that fits and keeps the working set below eviction", () => {
    for (const [limits, tileHeightPx] of [[direct, 4092], [relayed, 682]] as const) {
      const g = resolveGeometry({ cols: 216, rows: 65 }, CELL, limits);
      expect(g.tileHeightPx).toBe(tileHeightPx);
      expect(g.maxResident * tileBytes(g)).toBeGreaterThanOrEqual(visibleBytes(g));
      expect(g.maxResident).toBeLessThanOrEqual(g.maxTotalResident);
      expect(g.maxTotalResident * tileBytes(g)).toBeLessThanOrEqual(limits.storageBytes);
    }
  });

  test("downscales only on the relay and only when full resolution cannot fit", () => {
    expect(resolveGeometry({ cols: 216, rows: 65 }, CELL, relayed).renderScale).toBe(2);
    const full = resolveGeometry({ cols: 300, rows: 65 }, CELL, direct);
    expect(full.renderScale).toBe(2);
    expect(full.imgWidthPx).toBe(300 * 14);
    const reduced = resolveGeometry({ cols: 300, rows: 65 }, CELL, relayed);
    expect(reduced.renderScale).toBe(1);
    expect(reduced.imgWidthPx).toBe((300 * 14) / 2);
  });

  test("screens too large for two generations report it and cap the budgets to storage", () => {
    const tall = resolveGeometry({ cols: 400, rows: 200 }, CELL, relayed);
    for (const g of [
      resolveGeometry({ cols: 2000, rows: 65 }, CELL, relayed),
      resolveGeometry({ cols: 24000, rows: 3 }, CELL, relayed),
      tall,
    ]) {
      expect(g.exceedsFrameLimit).toBe(false);
      expect(g.exceedsStorage).toBe(true);
      expect(g.maxResident).toBeLessThanOrEqual(g.maxTotalResident);
      expect(g.maxTotalResident * tileBytes(g)).toBeLessThanOrEqual(relayed.storageBytes);
    }
    expect(visibleBytes(tall)).toBeLessThanOrEqual(relayed.storageBytes);
    const huge = resolveGeometry({ cols: 300, rows: 201 }, CELL, direct);
    expect(huge.exceedsStorage).toBe(false);
  });

  test("a zero-column screen still captures a positive width", () => {
    const g = resolveGeometry({ cols: 0, rows: 20 }, CELL, direct);
    expect(g.viewportWidthCssPx).toBeGreaterThan(0);
    expect(g.imgWidthPx).toBeGreaterThan(0);
  });
});

describe("computeTiles", () => {
  test("tiles cover the document from the top without gaps in two-cell units", () => {
    const { tiles, truncated, contentHeightPx } = layout(9001);
    let y = 0;
    for (const tile of tiles) {
      expect(tile.topPx).toBe(y);
      expect(tile.heightPx % UNIT).toBe(0);
      y += tile.heightPx;
    }
    expect(y).toBeGreaterThanOrEqual(9001);
    expect(y - 9001).toBeLessThan(UNIT);
    expect(truncated).toBe(false);
    expect(contentHeightPx).toBe(9010);
  });
});

describe("clampScroll", () => {
  test("keeps the scroll inside the document on cell boundaries", () => {
    const { contentHeightPx } = layout(8000);
    expect(clampScroll(-100, contentHeightPx, ROWS, CELL_HPX, 2)).toBe(0);
    expect(clampScroll(37, contentHeightPx, ROWS, CELL_HPX, 2)).toBe(40);
    expect(clampScroll(10 ** 6, contentHeightPx, ROWS, CELL_HPX, 2)).toBe(8000 - ROWS * CELL_HPX);
    expect(clampScroll(100, layout(300).contentHeightPx, ROWS, CELL_HPX, 2)).toBe(0);
  });

  test("downscaled odd cells scroll in two-cell steps and still reach the tail", () => {
    const { contentHeightPx } = layout(3131, 31, 64);
    const max = maxScrollPx(contentHeightPx, 64, 31, 1);
    expect(max % 62).toBe(0);
    expect(max + 64 * 31).toBeGreaterThanOrEqual(contentHeightPx);
    expect(clampScroll(10 ** 6, contentHeightPx, 64, 31, 2)).toBe(3131 - 64 * 31);
  });
});

describe("backfillOrder", () => {
  test("fetches tiles nearest the view first, breaking ties upward when scrolling up", () => {
    const { tiles } = layout(1500);
    expect(backfillOrder(500, ROWS, CELL_HPX, tiles, -1)).toEqual([1, 0, 2]);
  });
});
