import { describe, expect, test } from "bun:test";
import {
  detectGraphicsLimits,
  fitsGraphicsFrame,
  imageTransferEstimatedSize,
  maxTilesInFrame,
  residentTileCapacity,
} from "./capacity.ts";

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
  test("tiles share no budget: each image is judged alone", () => {
    expect(fitsGraphicsFrame(RELAYED, 1512, 2046)).toBe(true);
    expect(2 * imageTransferEstimatedSize(1512 * 2046 * 4)).toBeGreaterThan(RELAYED.frameBytes!);
  });

  test("a single image over the transfer budget does not fit", () => {
    expect(fitsGraphicsFrame(RELAYED, 3024, 1984)).toBe(false);
  });

  test("the boundary is the 30 MiB effective budget including overhead, not 32 MiB of pixels", () => {
    const h = 1000;
    expect(fitsGraphicsFrame(RELAYED, 5875, h)).toBe(true);
    expect(fitsGraphicsFrame(RELAYED, 5876, h)).toBe(false);
    expect(Math.ceil((5897 * h * 4) / 3) * 4).toBeLessThanOrEqual(RELAYED.frameBytes!);
    expect(fitsGraphicsFrame(RELAYED, 5897, h)).toBe(false);
  });

  test("width and height matter symmetrically", () => {
    expect(fitsGraphicsFrame(RELAYED, 2000, 1000)).toBe(fitsGraphicsFrame(RELAYED, 1000, 2000));
  });

  test("216 cols in the measured environment does not fit at 1:1 but does at half in both directions", () => {
    const width = 216 * 14;
    const screenful = 64 * 31;
    expect(fitsGraphicsFrame(RELAYED, width, screenful)).toBe(false);
    expect(fitsGraphicsFrame(RELAYED, width / 2, screenful / 2)).toBe(true);
  });

  test("without a frame limit any size fits", () => {
    expect(fitsGraphicsFrame(DIRECT, 100000, 100000)).toBe(true);
  });
});

describe("residentTileCapacity", () => {
  test("leaves twenty percent of decoded storage for terminal bookkeeping", () => {
    expect(residentTileCapacity(16 * 1024 * 1024, RELAYED)).toBe(3);
  });
});

describe("maxTilesInFrame", () => {
  test("an aligned screen needs ceil, but a straddle needs one more", () => {
    expect(maxTilesInFrame(1984, 992)).toBe(3);
    expect(maxTilesInFrame(992, 992)).toBe(2);
    expect(maxTilesInFrame(0, 992)).toBe(1);
  });
});
