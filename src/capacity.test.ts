import { describe, expect, test } from "bun:test";
import { detectGraphicsLimits, fitsGraphicsFrame, pickRenderScale } from "./capacity.ts";

const RELAYED = detectGraphicsLimits({ HERDR_ENV: "1" });
const DIRECT = detectGraphicsLimits({});

describe("detectGraphicsLimits", () => {
  test.each([
    [{ HERDR_ENV: "1" }, true],
    [{ HERDR_ENV: "" }, false],
    [{ HERDR_ENV: "0" }, false],
    [{}, false],
  ])("%o → a frame limit applies: %p", (env, limited) => {
    expect(detectGraphicsLimits(env).frameBytes !== null).toBe(limited);
  });
});

describe("fitsGraphicsFrame", () => {
  const limitPx = (tiles: number) => RELAYED.frameBytes! / (tiles * 4 * (4 / 3));

  test.each([1, 2, 3])("the exact limit boundary moves with %i tiles", (tiles) => {
    const h = 1000;
    expect(fitsGraphicsFrame(RELAYED, Math.floor(limitPx(tiles) / h), h, tiles)).toBe(true);
    expect(fitsGraphicsFrame(RELAYED, Math.ceil(limitPx(tiles) / h) + 1, h, tiles)).toBe(false);
  });

  test("width and height matter symmetrically", () => {
    expect(fitsGraphicsFrame(RELAYED, 2000, 1000, 2)).toBe(
      fitsGraphicsFrame(RELAYED, 1000, 2000, 2),
    );
  });

  test("216 cols in the measured environment does not fit at 1:1 but does at half in both directions", () => {
    const width = 216 * 14;
    const screenful = 64 * 31;
    expect(fitsGraphicsFrame(RELAYED, width, screenful, 2)).toBe(false);
    expect(fitsGraphicsFrame(RELAYED, width / 2, screenful / 2, 2)).toBe(true);
  });

  test("without a frame limit any size fits", () => {
    expect(fitsGraphicsFrame(DIRECT, 100000, 100000, 100)).toBe(true);
  });
});

describe("pickRenderScale", () => {
  const base = { limits: RELAYED };
  const geo = (cols: number, contentRows: number) => ({
    ...base,
    viewportWidthCssPx: (cols * 14) / 2,
    tileHeightPx: contentRows * 31,
    viewportHeightPx: contentRows * 31,
    reducedScrollUnitPx: 62,
  });

  test("a directly connected terminal always stays at 1:1 regardless of width", () => {
    expect(pickRenderScale({ ...geo(400, 64), limits: DIRECT })).toEqual({
      renderScale: 2,
      exceedsFrameLimit: false,
    });
  });

  test("a width that fits stays at 1:1 (degrade only when necessary)", () => {
    expect(pickRenderScale(geo(100, 64))).toEqual({ renderScale: 2, exceedsFrameLimit: false });
  });

  test("the measured environment (216 cols) stays at 1:1 — one screen fits one tile, so nothing degrades", () => {
    expect(pickRenderScale(geo(216, 64))).toEqual({ renderScale: 2, exceedsFrameLimit: false });
  });

  test("a width that does not fit at 1:1 drops to downscaled", () => {
    expect(pickRenderScale(geo(300, 64))).toEqual({ renderScale: 1, exceedsFrameLimit: false });
  });

  test("a width that does not fit even downscaled raises exceedsFrameLimit (never passed off as low-res)", () => {
    expect(pickRenderScale(geo(2000, 64))).toEqual({ renderScale: 1, exceedsFrameLimit: true });
  });

  test("no downscaling when the unit would exceed the viewport (it would make the end unreachable)", () => {
    const g = {
      ...base,
      viewportWidthCssPx: 5000,
      tileHeightPx: 997,
      viewportHeightPx: 997,
      reducedScrollUnitPx: 1994,
    };
    expect(pickRenderScale(g).renderScale).toBe(2);
  });

  test("an even cell height can downscale even with a one-row content area (the unit does not widen)", () => {
    const g = {
      ...base,
      viewportWidthCssPx: 2000,
      tileHeightPx: 2000,
      viewportHeightPx: 1000,
      reducedScrollUnitPx: 1000,
    };
    expect(pickRenderScale(g)).toEqual({ renderScale: 1, exceedsFrameLimit: false });
  });

  test("a geometry whose screenful exceeds the tile height is judged by the tiles actually needed", () => {
    const g = {
      ...base,
      viewportWidthCssPx: 1922,
      tileHeightPx: 4092,
      viewportHeightPx: 8000,
      reducedScrollUnitPx: 62,
    };
    expect(fitsGraphicsFrame(RELAYED, g.viewportWidthCssPx, 4092 / 2, 1)).toBe(true);
    expect(fitsGraphicsFrame(RELAYED, g.viewportWidthCssPx, 4092 / 2, 2)).toBe(false);
    expect(pickRenderScale(g)).toEqual({ renderScale: 1, exceedsFrameLimit: true });
  });
});
