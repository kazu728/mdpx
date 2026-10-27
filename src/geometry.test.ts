import { describe, expect, test } from "bun:test";
import {
  alignedTileHeightPx,
  backfillOrder,
  clampScroll,
  computeTiles,
  contentRows,
  detectGraphicsLimits,
  maxScrollPx,
  resolveGeometry,
  scrollUnitPx,
  toImagePx,
  visibleTiles,
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

describe("resolveGeometry", () => {
  function tileBytes(g: Geometry): number {
    return g.imgWidthPx * toImagePx(g.tileHeightPx, g.renderScale) * 4;
  }
  // Counts the tiles each scroll offset shows instead of reusing the planner's own bound.
  function visibleBytes(g: Geometry): number {
    const rows = contentRows(g.rows);
    const { tiles } = computeTiles(g.tileHeightPx + rows * g.cellHpx, g.cellHpx, rows, g.tileHeightPx);
    let most = 0;
    for (let scrollPx = 0; scrollPx < g.tileHeightPx; scrollPx += scrollUnitPx(g.cellHpx, g.renderScale)) {
      most = Math.max(most, visibleTiles(scrollPx, rows, g.cellHpx, tiles).length);
    }
    return most * tileBytes(g);
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
    expect(resolveGeometry({ cols: 216, rows: 65 }, CELL, relayed).renderScale).toBe(1);
    const full = resolveGeometry({ cols: 300, rows: 65 }, CELL, direct);
    expect(full.renderScale).toBe(1);
    expect(full.imgWidthPx).toBe(300 * 14);
    const reduced = resolveGeometry({ cols: 300, rows: 65 }, CELL, relayed);
    expect(reduced.renderScale).toBe(0.5);
    expect(reduced.imgWidthPx).toBe((300 * 14) / 2);
    expect(reduced.deviceScaleFactor).toBe(full.deviceScaleFactor / 2);
    expect(reduced.viewportWidthCssPx).toBe(full.viewportWidthCssPx);
  });

  test("a larger terminal font enlarges the page while the image keeps the window width", () => {
    const before = resolveGeometry({ cols: 216, rows: 65 }, CELL, direct);
    const after = resolveGeometry({ cols: 189, rows: 56 }, { cellHpx: 35, cellWpx: 16 }, direct);
    expect(after.imgWidthPx).toBe(before.imgWidthPx);
    expect(before.deviceScaleFactor).toBe(31 / 16);
    expect(after.deviceScaleFactor).toBe(35 / 16);
    expect(after.viewportWidthCssPx).toBeLessThan(before.viewportWidthCssPx);
    for (const g of [before, after]) {
      expect(g.viewportWidthCssPx * g.deviceScaleFactor).toBeGreaterThanOrEqual(g.imgWidthPx);
    }
  });

  test("screens too large for two generations still show one and cap the budgets to storage", () => {
    for (const g of [
      resolveGeometry({ cols: 2000, rows: 65 }, CELL, relayed),
      resolveGeometry({ cols: 24000, rows: 4 }, CELL, relayed),
      resolveGeometry({ cols: 400, rows: 200 }, CELL, relayed),
    ]) {
      expect(2 * visibleBytes(g)).toBeGreaterThan(relayed.storageBytes);
      expect(visibleBytes(g)).toBeLessThanOrEqual(relayed.storageBytes);
      expect(g.maxResident).toBeLessThanOrEqual(g.maxTotalResident);
      expect(g.maxTotalResident * tileBytes(g)).toBeLessThanOrEqual(relayed.storageBytes);
    }
    const huge = resolveGeometry({ cols: 300, rows: 201 }, CELL, direct);
    expect(2 * visibleBytes(huge)).toBeLessThanOrEqual(direct.storageBytes);
  });

  test("sizes a tile by its base64 transfer, not its raw pixels", () => {
    // A full-scale tile's raw RGBA fits the frame here, but not once base64 grows it by a third.
    const g = resolveGeometry({ cols: 6800, rows: 65 }, CELL, relayed);
    expect(Math.ceil(tileBytes(g) / 3) * 4).toBeLessThanOrEqual(relayed.frameBytes!);
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
    expect(clampScroll(-100, contentHeightPx, ROWS, CELL_HPX, 1)).toBe(0);
    expect(clampScroll(37, contentHeightPx, ROWS, CELL_HPX, 1)).toBe(40);
    expect(clampScroll(10 ** 6, contentHeightPx, ROWS, CELL_HPX, 1)).toBe(8000 - ROWS * CELL_HPX);
    expect(clampScroll(100, layout(300).contentHeightPx, ROWS, CELL_HPX, 1)).toBe(0);
  });

  test("downscaled odd cells scroll in two-cell steps and still reach the tail", () => {
    const { contentHeightPx } = layout(3131, 31, 64);
    const max = maxScrollPx(contentHeightPx, 64, 31, 0.5);
    expect(max % 62).toBe(0);
    expect(max + 64 * 31).toBeGreaterThanOrEqual(contentHeightPx);
    expect(clampScroll(10 ** 6, contentHeightPx, 64, 31, 1)).toBe(3131 - 64 * 31);
  });
});

describe("backfillOrder", () => {
  test("fetches tiles nearest the view first, breaking ties upward when scrolling up", () => {
    const { tiles } = layout(1500);
    expect(backfillOrder(500, ROWS, CELL_HPX, tiles, -1)).toEqual([1, 0, 2]);
  });
});
