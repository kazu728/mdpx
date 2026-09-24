import { describe, expect, test } from "bun:test";
import {
  detectGraphicsLimits,
  fitsGraphicsFrame,
  maxTilesInFrame,
  resolveGeometry,
  type Geometry,
  type GraphicsLimits,
} from "./geometry.ts";
import { toImagePx } from "./viewport.ts";

describe("resolveGeometry", () => {
  const cell = { cellHpx: 31, cellWpx: 14 };
  const direct = detectGraphicsLimits({});
  const relayed = detectGraphicsLimits({ HERDR_ENV: "1" });

  const tileBytes = (g: Geometry) =>
    g.imgWidthPx * toImagePx(g.tileHeightPx, g.renderScale) * 4;
  function expectFits(g: Geometry, limits: GraphicsLimits, viewportH: number, gens: number) {
    expect(fitsGraphicsFrame(limits, g.imgWidthPx, toImagePx(g.tileHeightPx, g.renderScale))).toBe(
      true,
    );
    const bytes = tileBytes(g);
    expect(gens * maxTilesInFrame(viewportH, g.tileHeightPx) * bytes).toBeLessThanOrEqual(
      limits.storageBytes,
    );
    expect(g.maxTotalResident * bytes).toBeLessThanOrEqual(limits.storageBytes);
  }

  test("direct stays 1:1 with screen-width image", () => {
    const g = resolveGeometry({ cols: 216, rows: 65 }, cell, direct);
    expect(g.renderScale).toBe(2);
    expect(g.exceedsFrameLimit).toBe(false);
    expect(g.imgWidthPx).toBe(216 * cell.cellWpx);
    expect<number>(g.tileHeightPx).toBe(4092);
  });

  test("relayed prefers full resolution while it fits", () => {
    const g = resolveGeometry({ cols: 216, rows: 65 }, cell, relayed);
    expect(g.renderScale).toBe(2);
    expect<number>(g.tileHeightPx).toBe(682);
    expect(g.maxResident).toBe(6);
    expect(g.exceedsFrameLimit).toBe(false);
    expectFits(g, relayed, 64 * cell.cellHpx, 2);
  });

  test("downscales only when full does not fit", () => {
    const screen = { cols: 300, rows: 65 };
    expect(resolveGeometry(screen, cell, direct).renderScale).toBe(2);
    const reduced = resolveGeometry(screen, cell, relayed);
    expect(reduced.renderScale).toBe(1);
    expect(reduced.imgWidthPx).toBe(Math.round((screen.cols * cell.cellWpx) / 2));
  });

  test("overflow reports too many with capped budgets", () => {
    for (const g of [
      resolveGeometry({ cols: 2000, rows: 65 }, cell, relayed),
      resolveGeometry({ cols: 24000, rows: 3 }, cell, relayed),
      resolveGeometry({ cols: 400, rows: 200 }, cell, relayed),
    ]) {
      expect(g.exceedsFrameLimit).toBe(false);
      expect(g.exceedsStorage).toBe(true);
      expect(g.maxResident).toBeLessThanOrEqual(g.maxTotalResident);
    }
    expectFits(resolveGeometry({ cols: 400, rows: 200 }, cell, relayed), relayed, 199 * cell.cellHpx, 1);
    expectFits(resolveGeometry({ cols: 300, rows: 201 }, cell, direct), direct, 200 * cell.cellHpx, 2);
  });

  test("one-row scale follows tail reachability", () => {
    expect(resolveGeometry({ cols: 10000, rows: 2 }, { cellHpx: 997, cellWpx: 1 }, relayed).renderScale).toBe(2);
    expect(resolveGeometry({ cols: 8000, rows: 2 }, { cellHpx: 1000, cellWpx: 1 }, relayed).renderScale).toBe(1);
  });
});

describe("detectGraphicsLimits", () => {
  test.each([
    [{ HERDR_ENV: "1" }, true],
    [{ HERDR_ENV: "" }, false],
    [{ HERDR_ENV: "0" }, false],
    [{}, false],
  ])("%o → limited: %p", (env, limited) => {
    expect(detectGraphicsLimits(env).frameBytes !== null).toBe(limited);
  });
});

describe("fitsGraphicsFrame", () => {
  const relayed = detectGraphicsLimits({ HERDR_ENV: "1" });

  test("each image judged alone", () => {
    expect(fitsGraphicsFrame(relayed, 1512, 2046)).toBe(true);
    expect(fitsGraphicsFrame(relayed, 3024, 1984)).toBe(false);
  });
});
