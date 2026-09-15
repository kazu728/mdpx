import { describe, expect, test } from "bun:test";
import {
  alignedTileHeightPx,
  backfillOrder,
  clampScroll,
  computeTiles,
  coveredHeightPx,
  maxScrollPx,
  maximumTileHeightPx,
  scrollUnitPx,
  toImagePx,
  visibleTiles,
} from "./viewport.ts";
import { IMAGE_ID_GENERATION_STRIDE } from "./kitty.ts";

function computeScreenfulTiles(documentHeightPx: number, cellHpx: number, contentRows: number) {
  return computeTiles(
    documentHeightPx,
    cellHpx,
    contentRows,
    alignedTileHeightPx(cellHpx, contentRows),
  );
}

describe("alignedTileHeightPx", () => {
  test.each([10, 14, 31])("cellHpx=%i covers a screenful within one unit", (cellHpx) => {
    const th = alignedTileHeightPx(cellHpx, 50);
    expect(th % cellHpx).toBe(0);
    expect(th % 2).toBe(0);
    expect(th).toBeGreaterThanOrEqual(50 * cellHpx);
    expect(th - 50 * cellHpx).toBeLessThan(cellHpx * 2);
  });

  test("caps at 4096 and stays positive", () => {
    expect(alignedTileHeightPx(31, 1000)).toBeLessThanOrEqual(4096);
    expect<number>(maximumTileHeightPx(31)).toBe(4092);
    expect<number>(alignedTileHeightPx(31, 0)).toBe(62);
  });
});

describe("computeTiles", () => {
  test("covers with no gaps, each a cell multiple", () => {
    const { tiles, truncated } = computeScreenfulTiles(9000, 10, 50);
    expect(truncated).toBe(false);
    let y = 0;
    for (const t of tiles) {
      expect<number>(t.topPx).toBe(y);
      expect(t.heightPx % 20).toBe(0);
      y += t.heightPx;
    }
    expect<number>(coveredHeightPx(tiles)).toBe(y);
    expect(y).toBeGreaterThanOrEqual(9000);
    expect(y - 9000).toBeLessThan(20);
  });

  test("cap truncates within ID space", () => {
    const over = computeScreenfulTiles(10 ** 7, 10, 50);
    expect(over.truncated).toBe(true);
    expect(over.tiles.length).toBeLessThan(IMAGE_ID_GENERATION_STRIDE);
    expect(computeScreenfulTiles(10 ** 8, 31, 0).tiles).toEqual([]);
  });

  test("empty document yields zero tiles", () => {
    const { tiles, contentHeightPx } = computeScreenfulTiles(0, 10, 50);
    expect(tiles.length).toBe(0);
    expect<number>(maxScrollPx(contentHeightPx, 50, 10, 2)).toBe(0);
  });

  test("contentHeightPx excludes tile padding, caps when truncated", () => {
    expect<number>(computeScreenfulTiles(489, 10, 50).contentHeightPx).toBe(490);
    const { tiles, contentHeightPx } = computeScreenfulTiles(4080 * 100, 10, 50);
    expect<number>(contentHeightPx).toBe(coveredHeightPx(tiles));
  });
});

describe("visibleTiles", () => {
  test("one screen uses a single tile", () => {
    const { tiles } = computeScreenfulTiles(300, 10, 50);
    const p = visibleTiles(0, 50, 10, tiles);
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({
      tileIndex: 0,
      sourceTopPx: 0,
      sourceHeightPx: 300,
      destinationRow: 0,
      destinationRows: 30,
    });
  });

  test("across a boundary two tiles fill the rows and stop at covered height", () => {
    const { tiles, contentHeightPx } = computeScreenfulTiles(8000, 10, 50);
    const p = visibleTiles(clampScroll(3800, contentHeightPx, 50, 10, 2), 50, 10, tiles);
    expect(p).toHaveLength(2);
    expect(p[0]).toMatchObject({ tileIndex: 7, sourceTopPx: 300, destinationRow: 0 });
    expect(p[1]).toMatchObject({ tileIndex: 8, sourceTopPx: 0, destinationRow: 20 });
    expect(p[0]!.destinationRows + p[1]!.destinationRows).toBe(50);
    const max = maxScrollPx(contentHeightPx, 50, 10, 2);
    const last = visibleTiles(max, 50, 10, tiles).at(-1)!;
    expect(tiles[last.tileIndex]!.topPx + last.sourceTopPx + last.sourceHeightPx).toBe(
      coveredHeightPx(tiles),
    );
  });
});

describe("backfillOrder", () => {
  test("equidistant tie follows scroll direction", () => {
    const { tiles, contentHeightPx } = computeScreenfulTiles(1500, 10, 50);
    const scroll = clampScroll(500, contentHeightPx, 50, 10, 2);
    expect(backfillOrder(scroll, 50, 10, tiles, 1).slice(0, 3)).toEqual([1, 2, 0]);
    expect(backfillOrder(scroll, 50, 10, tiles, -1).slice(0, 3)).toEqual([1, 0, 2]);
  });
});

describe("coordinates when downscaled", () => {
  test("image px and scroll unit", () => {
    expect(toImagePx(1984, 2)).toBe(1984);
    expect(toImagePx(1984, 1)).toBe(992);
    expect(scrollUnitPx(31, 2)).toBe(31);
    expect(scrollUnitPx(31, 1)).toBe(62);
    expect(scrollUnitPx(30, 1)).toBe(30);
    for (const cellHpx of [10, 14, 30, 31, 33]) {
      const unit = scrollUnitPx(cellHpx, 1);
      expect(unit % 2).toBe(0);
      expect(unit % cellHpx).toBe(0);
    }
  });

  test("max rounds up so tail stays reachable without leaving the document", () => {
    const { contentHeightPx } = computeScreenfulTiles(3131, 31, 64);
    const max = maxScrollPx(contentHeightPx, 64, 31, 1);
    expect<number>(max).toBe(1178);
    expect(max % 62).toBe(0);
    expect(max + 64 * 31).toBeGreaterThanOrEqual(contentHeightPx);
    expect<number>(maxScrollPx(contentHeightPx, 64, 31, 2)).toBe(3131 - 64 * 31);
    const down = clampScroll(0 + 62, contentHeightPx, 64, 31, 1);
    expect<number>(down).toBe(62);
    expect<number>(clampScroll(down - 62, contentHeightPx, 64, 31, 1)).toBe(0);
  });
});

describe("clampScroll", () => {
  const { contentHeightPx } = computeScreenfulTiles(8000, 10, 50);

  test("clamps and snaps to cell multiple", () => {
    expect<number>(clampScroll(-100, contentHeightPx, 50, 10, 2)).toBe(0);
    expect<number>(clampScroll(999999, contentHeightPx, 50, 10, 2)).toBe(7500);
    expect<number>(clampScroll(37, contentHeightPx, 50, 10, 2)).toBe(40);
    const short = computeScreenfulTiles(300, 10, 50).contentHeightPx;
    expect<number>(clampScroll(100, short, 50, 10, 2)).toBe(0);
  });
});
