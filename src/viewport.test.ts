import { describe, expect, test } from "bun:test";
import {
  clampScroll,
  computeTiles,
  coveredHeight,
  maxScrollPx,
  scrollUnitPx,
  tileHeightPx,
  toImagePx,
  visibleTiles,
} from "./viewport.ts";
import { ID_STRIDE } from "./kitty.ts";

describe("tileHeightPx", () => {
  test.each([10, 14, 31])("cellHpx=%i is a multiple of both the cell height and the dsf (2)", (cellHpx) => {
    const th = tileHeightPx(cellHpx, 50);
    expect(th % cellHpx).toBe(0); // placement rows are integers
    expect(th % 2).toBe(0); // the screenshot's CSS px clip is an integer
  });

  test.each([10, 14, 31])("cellHpx=%i gives the smallest aligned unit covering one screenful", (cellHpx) => {
    const unit = cellHpx * 2;
    const th = tileHeightPx(cellHpx, 50);
    expect(th).toBeGreaterThanOrEqual(50 * cellHpx); // covers the viewport
    expect(th - 50 * cellHpx).toBeLessThan(unit); // and is the smallest that does
  });

  test("never exceeds the sanity cap of 4096", () => {
    const th = tileHeightPx(31, 1000); // a viewport of about 31000px
    expect(th).toBeLessThanOrEqual(4096);
    expect(th % 62).toBe(0);
  });

  test("the tile height stays positive even at contentRows=0 (which is what stops computeTiles)", () => {
    expect<number>(tileHeightPx(31, 0)).toBe(62);
  });
});

describe("computeTiles", () => {
  test("covers the document with no gaps, each tile height a multiple of the cell height", () => {
    const { tiles, truncated } = computeTiles(9000, 10, 50);
    expect(truncated).toBe(false);
    let y = 0;
    for (const t of tiles) {
      expect<number>(t.y).toBe(y);
      expect(t.height % 20).toBe(0); // aligned to 2*cellHpx
      y += t.height;
    }
    expect<number>(coveredHeight(tiles)).toBe(y);
    expect(y).toBeGreaterThanOrEqual(9000);
    expect(y - 9000).toBeLessThan(20); // the padding is under one unit
  });

  test("a document past the cap is truncated at the tail", () => {
    const { truncated } = computeTiles(10 ** 7, 10, 50);
    expect(truncated).toBe(true);
  });

  test("geometries whose screenful fits the tile height cap all reach 128 screens", () => {
    for (const [cellHpx, contentRows] of [
      [10, 50],
      [31, 64],
      [31, 8],
      [14, 16],
    ]) {
      const { tiles, truncated } = computeTiles(10 ** 7, cellHpx!, contentRows!);
      expect(truncated).toBe(true);
      expect(tiles.length).toBe(128);
      expect<number>(coveredHeight(tiles)).toBe(128 * tileHeightPx(cellHpx!, contentRows!));
      expect<number>(tileHeightPx(cellHpx!, contentRows!)).toBe(contentRows! * cellHpx!); // one screenful
    }
  });

  test("geometries whose screenful exceeds the tile height cap reach fewer than 128 screens", () => {
    // Capped by MAX_TILE_PX, a tile becomes smaller than a screen. The tile count exists to bound
    // capture cost, not to guarantee how many screens are reachable (§4.4)
    for (const [cellHpx, contentRows] of [
      [31, 199],
      [31, 299],
      [1000, 50],
    ]) {
      const screenful = contentRows! * cellHpx!;
      const th = tileHeightPx(cellHpx!, contentRows!);
      expect(th).toBeLessThan(screenful);
      const { tiles } = computeTiles(10 ** 8, cellHpx!, contentRows!);
      expect(coveredHeight(tiles) / screenful).toBeLessThan(128);
    }
  });

  test("the tile count always stays below the ID space (preventing image ID collisions)", () => {
    // image id = gen*ID_STRIDE + tileIndex. Once tileIndex reaches ID_STRIDE it equals the next
    // generation's first id, and deleting on a generation switch would wipe another generation's
    // images (§4.4)
    for (const [cellHpx, contentRows] of [
      [10, 20],
      [31, 8],
      [14, 16],
      [10, 0],
    ]) {
      expect(computeTiles(10 ** 7, cellHpx!, contentRows!).tiles.length).toBeLessThan(ID_STRIDE);
    }
  });

  test("an empty document yields zero tiles", () => {
    const { tiles, contentHpx } = computeTiles(0, 10, 50);
    expect(tiles.length).toBe(0);
    expect(maxScrollPx(contentHpx, 50, 10, 2)).toBe(0);
  });

  test("a zero-row content area captures nothing", () => {
    // rows=1 (all status bar). There is nowhere to place a capture, so skip the pointless capture and transfer
    const { tiles, truncated, contentHpx } = computeTiles(10 ** 8, 31, 0);
    expect(tiles).toEqual([]);
    expect(truncated).toBe(false);
    expect(contentHpx).toBe(0);
  });

  test("contentHpx is the real document height rounded to a cell multiple (tile padding excluded)", () => {
    // docHpx=489, cellHpx=10 → tiles cover up to 500 at the 2*cellHpx=20 boundary, but the scroll
    // limit uses the real document height's cell multiple, 490 (no scrolling into the trailing padding).
    const { contentHpx } = computeTiles(489, 10, 50);
    expect(contentHpx).toBe(490);
    // contentRows=49 → it fits the 490px viewport, so there is nothing to scroll
    expect(maxScrollPx(contentHpx, 49, 10, 2)).toBe(0);
  });

  test("when truncated, contentHpx caps at the captured bottom (coveredHeight)", () => {
    const { tiles, contentHpx } = computeTiles(4080 * 100, 10, 50);
    expect(contentHpx).toBe(coveredHeight(tiles));
  });
});

describe("visibleTiles", () => {
  test("a document fitting one screen uses a single tile whose rows are the content height", () => {
    const { tiles } = computeTiles(300, 10, 50);
    const p = visibleTiles(0, 50, 10, tiles);
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ tileIndex: 0, srcY: 0, srcH: 300, row: 0, rows: 30 });
  });

  test("across a tile boundary, two tiles are placed back to back and fill the rows", () => {
    const { tiles } = computeTiles(8000, 10, 50); // sixteen 500px tiles
    const p = visibleTiles(3800, 50, 10, tiles);
    expect(p).toHaveLength(2);
    expect(p[0]).toMatchObject({ tileIndex: 7, srcY: 300, srcH: 200, row: 0, rows: 20 });
    expect(p[1]).toMatchObject({ tileIndex: 8, srcY: 0, srcH: 300, row: 20, rows: 30 });
    expect(p[0]!.rows + p[1]!.rows).toBe(50); // contentRows is filled with no gaps
  });

  test("end of the document: the bottom stops at the covered height and no row overflows", () => {
    const { tiles, contentHpx } = computeTiles(8000, 10, 50);
    const max = maxScrollPx(contentHpx, 50, 10, 2); // 7500
    const p = visibleTiles(max, 50, 10, tiles);
    const bottom = tiles[p.at(-1)!.tileIndex]!.y + p.at(-1)!.srcY + p.at(-1)!.srcH;
    expect(bottom).toBe(coveredHeight(tiles));
    expect(p.reduce((s, x) => s + x.rows, 0)).toBeLessThanOrEqual(50);
  });
});

describe("coordinates when downscaled (§4.8)", () => {
  test("at 1:1 the image px equals the screen px and the scroll unit is one cell", () => {
    expect(toImagePx(1984, 2)).toBe(1984);
    expect(scrollUnitPx(31, 2)).toBe(31);
    expect(scrollUnitPx(30, 2)).toBe(30);
  });

  test("downscaled, the image px halves and an odd cell height makes the unit two cells", () => {
    expect(toImagePx(1984, 1)).toBe(992);
    expect(scrollUnitPx(31, 1)).toBe(62); // odd → one cell leaves half a px over
    expect(scrollUnitPx(30, 1)).toBe(30); // even → one cell stands
  });

  test("scroll unit boundaries always map to integer image px", () => {
    for (const cellHpx of [10, 14, 30, 31, 33]) {
      const unit = scrollUnitPx(cellHpx, 1);
      expect(unit % 2).toBe(0); // image px = unit/2 is an integer
      expect(unit % cellHpx).toBe(0); // placement rows stay integers
    }
  });

  test("max rounds up to the unit so the real content at the tail is reachable", () => {
    // cellHpx=31, contentRows=64 → unit 62. At contentHpx=3131 the raw max is 1147.
    // Rounding down (1116) puts the bottom edge at 3100 and leaves the last 31px unreachable, so it
    // rounds up to 1178
    const contentHpx = 3131;
    const max = maxScrollPx(contentHpx, 64, 31, 1);
    expect(max).toBe(1178);
    expect(max % 62).toBe(0); // srcY maps to integer image px
    expect(max + 64 * 31).toBeGreaterThanOrEqual(contentHpx); // the tail is inside the viewport
    expect(clampScroll(99999, contentHpx, 64, 31, 1)).toBe(max);
  });

  test("max never leaves the document (the body does not vanish at the end)", () => {
    // With a viewport shorter than one unit, a naive round-up puts the top edge outside the document
    // where it overlaps no tile. §4.8's downscale check rejects such geometries, but this guards
    // viewport on its own
    for (const [cellHpx, docHpx] of [
      [31, 3100],
      [21, 489],
      [33, 5000],
    ]) {
      const { tiles, contentHpx } = computeTiles(docHpx!, cellHpx!, 1);
      const max = maxScrollPx(contentHpx, 1, cellHpx!, 1);
      expect(visibleTiles(max, 1, cellHpx!, tiles).length).toBeGreaterThan(0);
    }
  });

  test("geometries allowed to downscale can still reach the end of the document", () => {
    // §4.8 only downscales geometries where the scroll unit fits the viewport. Pin down that the end
    // stays readable across that range (so loosening it fails here)
    for (const [cellHpx, contentRows, docHpx] of [
      [31, 64, 3131],
      [31, 2, 3100],
      [30, 1, 3000],
      [21, 7, 5000],
    ]) {
      const unit = scrollUnitPx(cellHpx!, 1);
      expect(contentRows! * cellHpx!).toBeGreaterThanOrEqual(unit); // the precondition for downscaling
      const { contentHpx } = computeTiles(docHpx!, cellHpx!, contentRows!);
      const max = maxScrollPx(contentHpx, contentRows!, cellHpx!, 1);
      expect(max + contentRows! * cellHpx!).toBeGreaterThanOrEqual(contentHpx); // the tail is inside the viewport
    }
  });

  test("a line step advances by one unit and returns on the way back (no sticking on midpoint rounding)", () => {
    const contentHpx = 3131;
    const down = clampScroll(0 + 62, contentHpx, 64, 31, 1);
    expect(down).toBe(62);
    expect(clampScroll(down - 62, contentHpx, 64, 31, 1)).toBe(0);
  });

  test("at 1:1 the round-up in max is a no-op (as before)", () => {
    const contentHpx = 3131;
    expect(maxScrollPx(contentHpx, 64, 31, 2)).toBe(3131 - 64 * 31);
  });
});

describe("clampScroll", () => {
  const { contentHpx } = computeTiles(8000, 10, 50); // maxScroll 7500

  test("negative goes to 0 and anything past the end to max", () => {
    expect(clampScroll(-100, contentHpx, 50, 10, 2)).toBe(0);
    expect(clampScroll(999999, contentHpx, 50, 10, 2)).toBe(7500);
  });

  test("snaps to a multiple of the cell height", () => {
    expect(clampScroll(37, contentHpx, 50, 10, 2)).toBe(40);
    expect(clampScroll(34, contentHpx, 50, 10, 2)).toBe(30);
  });

  test("a short document always stays at 0", () => {
    const short = computeTiles(300, 10, 50).contentHpx;
    expect(clampScroll(100, short, 50, 10, 2)).toBe(0);
  });
});
