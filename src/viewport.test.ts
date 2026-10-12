import { describe, expect, test } from "bun:test";
import {
  alignedTileHeightPx,
  backfillOrder,
  clampScroll,
  computeTiles,
  maxScrollPx,
} from "./viewport.ts";

const CELL = 10;
const ROWS = 50;
const UNIT = 2 * CELL;

function layout(documentHeightPx: number, cellHpx = CELL, rows = ROWS) {
  return computeTiles(documentHeightPx, cellHpx, rows, alignedTileHeightPx(cellHpx, rows));
}

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
    expect(clampScroll(-100, contentHeightPx, ROWS, CELL, 2)).toBe(0);
    expect(clampScroll(37, contentHeightPx, ROWS, CELL, 2)).toBe(40);
    expect(clampScroll(10 ** 6, contentHeightPx, ROWS, CELL, 2)).toBe(8000 - ROWS * CELL);
    expect(clampScroll(100, layout(300).contentHeightPx, ROWS, CELL, 2)).toBe(0);
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
    expect(backfillOrder(500, ROWS, CELL, tiles, -1)).toEqual([1, 0, 2]);
  });
});
