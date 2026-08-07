import { describe, expect, test } from "bun:test";
import {
  alignedTileHeightPx,
  backfillOrder,
  clampScroll,
  computeTiles,
  coveredHeightPx,
  maxScrollPx,
  maximumTileHeightPx,
  SCROLL_TOP,
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
  test.each([10, 14, 31])("cellHpx=%i is a multiple of both the cell height and the dsf (2)", (cellHpx) => {
    const th = alignedTileHeightPx(cellHpx, 50);
    expect(th % cellHpx).toBe(0);
    expect(th % 2).toBe(0);
  });

  test.each([10, 14, 31])("cellHpx=%i gives the smallest aligned unit covering one screenful", (cellHpx) => {
    const unit = cellHpx * 2;
    const th = alignedTileHeightPx(cellHpx, 50);
    expect(th).toBeGreaterThanOrEqual(50 * cellHpx);
    expect(th - 50 * cellHpx).toBeLessThan(unit);
  });

  test("never exceeds the sanity cap of 4096", () => {
    const th = alignedTileHeightPx(31, 1000);
    expect(th).toBeLessThanOrEqual(4096);
    expect(th % 62).toBe(0);
  });

  test("the maximum height uses the largest aligned value within the cap", () => {
    expect<number>(maximumTileHeightPx(31)).toBe(4092);
  });

  test("the tile height stays positive even at contentRows=0 (which is what stops computeTiles)", () => {
    expect<number>(alignedTileHeightPx(31, 0)).toBe(62);
  });
});

describe("computeTiles", () => {
  test("uses the tile height selected by the caller", () => {
    const tileHeight = maximumTileHeightPx(10);
    const { tiles } = computeTiles(9000, 10, 50, tileHeight);
    expect<number>(tiles[0]!.heightPx).toBe(tileHeight);
    expect<number>(tiles[1]!.topPx).toBe(tileHeight);
  });

  test("covers the document with no gaps, each tile height a multiple of the cell height", () => {
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

  test("a document past the cap is truncated at the tail", () => {
    const { truncated } = computeScreenfulTiles(10 ** 7, 10, 50);
    expect(truncated).toBe(true);
  });

  test("geometries whose screenful fits the tile height cap all reach 128 screens", () => {
    for (const [cellHpx, contentRows] of [
      [10, 50],
      [31, 64],
      [31, 8],
      [14, 16],
    ]) {
      const { tiles, truncated } = computeScreenfulTiles(10 ** 7, cellHpx!, contentRows!);
      expect(truncated).toBe(true);
      expect(tiles.length).toBe(128);
      expect<number>(coveredHeightPx(tiles)).toBe(128 * alignedTileHeightPx(cellHpx!, contentRows!));
      expect<number>(alignedTileHeightPx(cellHpx!, contentRows!)).toBe(contentRows! * cellHpx!);
    }
  });

  test("geometries whose screenful exceeds the tile height cap reach fewer than 128 screens", () => {
    for (const [cellHpx, contentRows] of [
      [31, 199],
      [31, 299],
      [1000, 50],
    ]) {
      const screenful = contentRows! * cellHpx!;
      const th = alignedTileHeightPx(cellHpx!, contentRows!);
      expect(th).toBeLessThan(screenful);
      const { tiles } = computeScreenfulTiles(10 ** 8, cellHpx!, contentRows!);
      expect(coveredHeightPx(tiles) / screenful).toBeLessThan(128);
    }
  });

  test("the tile count always stays below the ID space (preventing image ID collisions)", () => {
    for (const [cellHpx, contentRows] of [
      [10, 20],
      [31, 8],
      [14, 16],
      [10, 0],
    ]) {
      expect(computeScreenfulTiles(10 ** 7, cellHpx!, contentRows!).tiles.length).toBeLessThan(
        IMAGE_ID_GENERATION_STRIDE,
      );
    }
  });

  test("an empty document yields zero tiles", () => {
    const { tiles, contentHeightPx } = computeScreenfulTiles(0, 10, 50);
    expect(tiles.length).toBe(0);
    expect<number>(maxScrollPx(contentHeightPx, 50, 10, 2)).toBe(0);
  });

  test("a zero-row content area captures nothing", () => {
    const { tiles, truncated, contentHeightPx } = computeScreenfulTiles(10 ** 8, 31, 0);
    expect(tiles).toEqual([]);
    expect(truncated).toBe(false);
    expect<number>(contentHeightPx).toBe(0);
  });

  test("contentHeightPx is the real document height rounded to a cell multiple (tile padding excluded)", () => {
    const { contentHeightPx } = computeScreenfulTiles(489, 10, 50);
    expect<number>(contentHeightPx).toBe(490);
    expect<number>(maxScrollPx(contentHeightPx, 49, 10, 2)).toBe(0);
  });

  test("when truncated, contentHeightPx caps at the captured bottom", () => {
    const { tiles, contentHeightPx } = computeScreenfulTiles(4080 * 100, 10, 50);
    expect<number>(contentHeightPx).toBe(coveredHeightPx(tiles));
  });
});

describe("visibleTiles", () => {
  test("a document fitting one screen uses a single tile whose rows are the content height", () => {
    const { tiles } = computeScreenfulTiles(300, 10, 50);
    const p = visibleTiles(SCROLL_TOP, 50, 10, tiles);
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({
      tileIndex: 0,
      sourceTopPx: 0,
      sourceHeightPx: 300,
      destinationRow: 0,
      destinationRows: 30,
    });
  });

  test("across a tile boundary, two tiles are placed back to back and fill the rows", () => {
    const { tiles, contentHeightPx } = computeScreenfulTiles(8000, 10, 50);
    const p = visibleTiles(clampScroll(3800, contentHeightPx, 50, 10, 2), 50, 10, tiles);
    expect(p).toHaveLength(2);
    expect(p[0]).toMatchObject({
      tileIndex: 7,
      sourceTopPx: 300,
      sourceHeightPx: 200,
      destinationRow: 0,
      destinationRows: 20,
    });
    expect(p[1]).toMatchObject({
      tileIndex: 8,
      sourceTopPx: 0,
      sourceHeightPx: 300,
      destinationRow: 20,
      destinationRows: 30,
    });
    expect(p[0]!.destinationRows + p[1]!.destinationRows).toBe(50);
  });

  test("end of the document: the bottom stops at the covered height and no row overflows", () => {
    const { tiles, contentHeightPx } = computeScreenfulTiles(8000, 10, 50);
    const max = maxScrollPx(contentHeightPx, 50, 10, 2);
    const p = visibleTiles(max, 50, 10, tiles);
    const bottom =
      tiles[p.at(-1)!.tileIndex]!.topPx +
      p.at(-1)!.sourceTopPx +
      p.at(-1)!.sourceHeightPx;
    expect(bottom).toBe(coveredHeightPx(tiles));
    expect(p.reduce((rows, placement) => rows + placement.destinationRows, 0)).toBeLessThanOrEqual(
      50,
    );
  });
});

describe("backfillOrder", () => {
  test("an equidistant tie follows the scroll direction", () => {
    const { tiles, contentHeightPx } = computeScreenfulTiles(1500, 10, 50);
    const scroll = clampScroll(500, contentHeightPx, 50, 10, 2);
    expect(backfillOrder(scroll, 50, 10, tiles, 1).slice(0, 3)).toEqual([1, 2, 0]);
    expect(backfillOrder(scroll, 50, 10, tiles, -1).slice(0, 3)).toEqual([1, 0, 2]);
  });
});

describe("coordinates when downscaled", () => {
  test("at 1:1 the image px equals the screen px and the scroll unit is one cell", () => {
    expect(toImagePx(1984, 2)).toBe(1984);
    expect(scrollUnitPx(31, 2)).toBe(31);
    expect(scrollUnitPx(30, 2)).toBe(30);
  });

  test("downscaled, the image px halves and an odd cell height makes the unit two cells", () => {
    expect(toImagePx(1984, 1)).toBe(992);
    expect(scrollUnitPx(31, 1)).toBe(62);
    expect(scrollUnitPx(30, 1)).toBe(30);
  });

  test("scroll unit boundaries always map to integer image px", () => {
    for (const cellHpx of [10, 14, 30, 31, 33]) {
      const unit = scrollUnitPx(cellHpx, 1);
      expect(unit % 2).toBe(0);
      expect(unit % cellHpx).toBe(0);
    }
  });

  test("max rounds up to the unit so the real content at the tail is reachable", () => {
    const { contentHeightPx } = computeScreenfulTiles(3131, 31, 64);
    expect<number>(contentHeightPx).toBe(3131);
    const max = maxScrollPx(contentHeightPx, 64, 31, 1);
    expect<number>(max).toBe(1178);
    expect(max % 62).toBe(0);
    expect(max + 64 * 31).toBeGreaterThanOrEqual(contentHeightPx);
    expect(clampScroll(99999, contentHeightPx, 64, 31, 1)).toBe(max);
  });

  test("max never leaves the document (the body does not vanish at the end)", () => {
    for (const [cellHpx, documentHeightPx] of [
      [31, 3100],
      [21, 489],
      [33, 5000],
    ]) {
      const { tiles, contentHeightPx } = computeScreenfulTiles(documentHeightPx!, cellHpx!, 1);
      const max = maxScrollPx(contentHeightPx, 1, cellHpx!, 1);
      expect(visibleTiles(max, 1, cellHpx!, tiles).length).toBeGreaterThan(0);
    }
  });

  test("geometries allowed to downscale can still reach the end of the document", () => {
    for (const [cellHpx, contentRows, documentHeightPx] of [
      [31, 64, 3131],
      [31, 2, 3100],
      [30, 1, 3000],
      [21, 7, 5000],
    ]) {
      const unit = scrollUnitPx(cellHpx!, 1);
      expect(contentRows! * cellHpx!).toBeGreaterThanOrEqual(unit);
      const { contentHeightPx } = computeScreenfulTiles(documentHeightPx!, cellHpx!, contentRows!);
      const max = maxScrollPx(contentHeightPx, contentRows!, cellHpx!, 1);
      expect(max + contentRows! * cellHpx!).toBeGreaterThanOrEqual(contentHeightPx);
    }
  });

  test("a line step advances by one unit and returns on the way back (no sticking on midpoint rounding)", () => {
    const { contentHeightPx } = computeScreenfulTiles(3131, 31, 64);
    const down = clampScroll(0 + 62, contentHeightPx, 64, 31, 1);
    expect<number>(down).toBe(62);
    expect<number>(clampScroll(down - 62, contentHeightPx, 64, 31, 1)).toBe(0);
  });

  test("at 1:1 the round-up in max is a no-op (as before)", () => {
    const { contentHeightPx } = computeScreenfulTiles(3131, 31, 64);
    expect<number>(maxScrollPx(contentHeightPx, 64, 31, 2)).toBe(3131 - 64 * 31);
  });
});

describe("clampScroll", () => {
  const { contentHeightPx } = computeScreenfulTiles(8000, 10, 50);

  test("negative goes to 0 and anything past the end to max", () => {
    expect<number>(clampScroll(-100, contentHeightPx, 50, 10, 2)).toBe(0);
    expect<number>(clampScroll(999999, contentHeightPx, 50, 10, 2)).toBe(7500);
  });

  test("snaps to a multiple of the cell height", () => {
    expect<number>(clampScroll(37, contentHeightPx, 50, 10, 2)).toBe(40);
    expect<number>(clampScroll(34, contentHeightPx, 50, 10, 2)).toBe(30);
  });

  test("a short document always stays at 0", () => {
    const short = computeScreenfulTiles(300, 10, 50).contentHeightPx;
    expect<number>(clampScroll(100, short, 50, 10, 2)).toBe(0);
  });
});
