import { describe, expect, test } from "bun:test";
import {
  detectGraphicsLimits,
  fitsGraphicsFrame,
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

describe("residentTileCapacity", () => {
  test("leaves twenty percent of decoded storage for terminal bookkeeping", () => {
    expect(residentTileCapacity(16 * 1024 * 1024, RELAYED)).toBe(3);
  });
});
