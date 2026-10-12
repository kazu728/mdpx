import { describe, expect, test } from "bun:test";
import {
  detectGraphicsLimits,
  fitsGraphicsFrame,
  maxTilesInFrame,
  resolveGeometry,
  type Geometry,
} from "./geometry.ts";
import { contentRows, toImagePx } from "./viewport.ts";

const CELL = { cellHpx: 31, cellWpx: 14 };
const direct = detectGraphicsLimits({});
const relayed = detectGraphicsLimits({ HERDR_ENV: "1" });

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
