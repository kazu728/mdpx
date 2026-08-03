import { describe, expect, test } from "bun:test";
import { fitsGraphicsFrame, inHerdrPane, pickRenderScale } from "./herdr.ts";

describe("inHerdrPane", () => {
  test.each([
    [{ HERDR_ENV: "1" }, true],
    [{ HERDR_ENV: "" }, false],
    [{ HERDR_ENV: "0" }, false], // truthy in JS, so it has to be excluded explicitly
    [{}, false],
  ])("%o → %p", (env, expected) => {
    expect(inHerdrPane(env)).toBe(expected);
  });
});

describe("fitsGraphicsFrame", () => {
  // The contract: it fits when tiles × width × height × 4 bytes × 4/3 is at most 32 MiB
  const limitPx = (tiles: number) => (32 * 1024 * 1024) / (tiles * 4 * (4 / 3));

  test.each([1, 2, 3])("the exact limit boundary moves with %i tiles", (tiles) => {
    const h = 1000;
    expect(fitsGraphicsFrame(Math.floor(limitPx(tiles) / h), h, tiles)).toBe(true);
    expect(fitsGraphicsFrame(Math.ceil(limitPx(tiles) / h) + 1, h, tiles)).toBe(false);
  });

  test("width and height matter symmetrically", () => {
    expect(fitsGraphicsFrame(2000, 1000, 2)).toBe(fitsGraphicsFrame(1000, 2000, 2));
  });

  // The downscale fallback is genuinely needed in the measured environment (14×31px cells, 65 rows,
  // 216 cols). That geometry is the whole motivation for §4.8, so it is pinned with real values
  // rather than at a boundary.
  test("216 cols in the measured environment does not fit at 1:1 but does at half in both directions", () => {
    const width = 216 * 14;
    const screenful = 64 * 31;
    expect(fitsGraphicsFrame(width, screenful, 2)).toBe(false);
    expect(fitsGraphicsFrame(width / 2, screenful / 2, 2)).toBe(true);
  });
});

describe("pickRenderScale", () => {
  const base = { fullScale: 2, relayed: true };
  const geo = (cols: number, contentRows: number) => ({
    ...base,
    cssWidth: (cols * 14) / 2,
    tileHpx: contentRows * 31,
    viewportHpx: contentRows * 31,
    reducedScrollUnitPx: 62,
  });

  test("an unrelayed terminal always stays at 1:1 regardless of width", () => {
    expect(pickRenderScale({ ...geo(400, 64), relayed: false })).toEqual({
      renderScale: 2,
      relayOverflow: false,
    });
  });

  test("a width that fits stays at 1:1 (degrade only when necessary)", () => {
    expect(pickRenderScale(geo(100, 64))).toEqual({ renderScale: 2, relayOverflow: false });
  });

  test("the measured environment (216 cols) stays at 1:1 — one screen fits one tile, so nothing degrades", () => {
    expect(pickRenderScale(geo(216, 64))).toEqual({ renderScale: 2, relayOverflow: false });
  });

  test("a width that does not fit at 1:1 drops to downscaled", () => {
    expect(pickRenderScale(geo(300, 64))).toEqual({ renderScale: 1, relayOverflow: false });
  });

  test("a width that does not fit even downscaled raises relayOverflow (never passed off as low-res)", () => {
    expect(pickRenderScale(geo(2000, 64))).toEqual({ renderScale: 1, relayOverflow: true });
  });

  test("no downscaling when the unit would exceed the viewport (it would make the end unreachable)", () => {
    // Cell height 997 (odd) → the unit when downscaled is 2 cells = 1994, out of reach for a one-row content area
    const g = { ...base, cssWidth: 5000, tileHpx: 997, viewportHpx: 997, reducedScrollUnitPx: 1994 };
    expect(pickRenderScale(g).renderScale).toBe(2);
  });

  test("an even cell height can downscale even with a one-row content area (the unit does not widen)", () => {
    // Cell height 1000 (even) → downscaled the unit is still one cell. Rejecting on row count alone
    // would leave geometries blank that would in fact have fit
    const g = { ...base, cssWidth: 2000, tileHpx: 2000, viewportHpx: 1000, reducedScrollUnitPx: 1000 };
    expect(pickRenderScale(g)).toEqual({ renderScale: 1, relayOverflow: false });
  });

  test("a geometry whose screenful exceeds the tile height is judged by the tiles actually needed", () => {
    // Once the tile height is capped by MAX_TILE_PX, one screen no longer fits in one tile. Judging by
    // a fixed single tile answers "it fits" and shows "low-res" over a blank screen
    const g = { ...base, cssWidth: 1922, tileHpx: 4092, viewportHpx: 8000, reducedScrollUnitPx: 62 };
    // One tile would fit when downscaled, but this screen needs two, so it does not actually fit
    expect(fitsGraphicsFrame(g.cssWidth, 4092 / 2, 1)).toBe(true);
    expect(fitsGraphicsFrame(g.cssWidth, 4092 / 2, 2)).toBe(false);
    expect(pickRenderScale(g)).toEqual({ renderScale: 1, relayOverflow: true });
  });
});
