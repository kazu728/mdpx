import { describe, expect, test } from "bun:test";
import { resolveGeometry } from "./geometry.ts";
import { detectGraphicsLimits } from "./capacity.ts";

describe("resolveGeometry", () => {
  const cell = { cellHpx: 31, cellWpx: 14 };
  const direct = detectGraphicsLimits({});
  const relayed = detectGraphicsLimits({ HERDR_ENV: "1" });

  test("a directly connected terminal stays at 1:1 with imgWidthPx matching the screen width", () => {
    const g = resolveGeometry({ cols: 216, rows: 65 }, cell, direct);
    expect(g.renderScale).toBe(2);
    expect(g.exceedsFrameLimit).toBe(false);
    expect(g.imgWidthPx).toBe(216 * cell.cellWpx);
    expect<number>(g.tileHeightPx).toBe(4092);
  });

  test("prefers full resolution for 216 cols while it fits the transfer and old+new storage budgets", async () => {
    const { fitsGraphicsFrame, maxTilesInFrame } = await import("./capacity.ts");
    const { toImagePx } = await import("./viewport.ts");
    const g = resolveGeometry({ cols: 216, rows: 65 }, cell, relayed);
    expect(g.renderScale).toBe(2);
    expect<number>(g.tileHeightPx).toBe(682);
    expect(g.maxResident).toBe(6);
    expect(g.exceedsFrameLimit).toBe(false);
    const viewportH = 64 * cell.cellHpx;
    const tilesInFrame = maxTilesInFrame(viewportH, g.tileHeightPx);
    const tileBytes = g.imgWidthPx * toImagePx(g.tileHeightPx, g.renderScale) * 4;
    expect(fitsGraphicsFrame(relayed, g.imgWidthPx, toImagePx(g.tileHeightPx, g.renderScale))).toBe(
      true,
    );
    expect(2 * tilesInFrame * tileBytes).toBeLessThanOrEqual(relayed.storageBytes);
    expect(g.maxTotalResident * tileBytes).toBeLessThanOrEqual(relayed.storageBytes);
  });

  test("prefers full resolution for 80 cols even though reduced could use a taller tile", async () => {
    const { fitsGraphicsFrame, maxTilesInFrame } = await import("./capacity.ts");
    const { toImagePx } = await import("./viewport.ts");
    const g = resolveGeometry({ cols: 80, rows: 65 }, cell, relayed);
    expect(g.renderScale).toBe(2);
    expect<number>(g.tileHeightPx).toBe(3720);
    expect(g.maxResident).toBe(3);
    expect(g.exceedsFrameLimit).toBe(false);
    const viewportH = 64 * cell.cellHpx;
    const tilesInFrame = maxTilesInFrame(viewportH, g.tileHeightPx);
    const tileBytes = g.imgWidthPx * toImagePx(g.tileHeightPx, g.renderScale) * 4;
    expect(fitsGraphicsFrame(relayed, g.imgWidthPx, toImagePx(g.tileHeightPx, g.renderScale))).toBe(
      true,
    );
    expect(2 * tilesInFrame * tileBytes).toBeLessThanOrEqual(relayed.storageBytes);
  });

  test("downscales only when full resolution does not fit, halving imgWidthPx too", () => {
    const screen = { cols: 300, rows: 65 };
    const full = resolveGeometry(screen, cell, direct);
    const reduced = resolveGeometry(screen, cell, relayed);
    expect(full.renderScale).toBe(2);
    expect(reduced.renderScale).toBe(1);
    expect(reduced.imgWidthPx).toBe(Math.round((screen.cols * cell.cellWpx) / 2));
    expect(reduced.viewportWidthCssPx).toBe(full.viewportWidthCssPx);
  });

  test("a directly connected terminal does not downscale even when it is very wide", () => {
    const g = resolveGeometry({ cols: 2000, rows: 65 }, cell, direct);
    expect(g.renderScale).toBe(2);
    expect(g.exceedsFrameLimit).toBe(false);
  });

  test("storage overflow without transfer overflow reports too many, not too wide", () => {
    const g = resolveGeometry({ cols: 2000, rows: 65 }, cell, relayed);
    expect(g.renderScale).toBe(1);
    expect(g.exceedsFrameLimit).toBe(false);
    expect(g.exceedsStorage).toBe(true);
    expect<number>(g.tileHeightPx).toBe(248);
    expect(g.maxResident).toBe(9);
    expect(g.maxResident).toBeLessThanOrEqual(g.maxTotalResident);
  });

  test("a relayed viewport with no room for a read-ahead tile downscales to stay within the straddled frame", () => {
    const g = resolveGeometry({ cols: 6000, rows: 3 }, cell, relayed);
    expect(g.renderScale).toBe(1);
    expect<number>(g.tileHeightPx).toBe(6 * cell.cellHpx);
    expect(g.exceedsFrameLimit).toBe(false);
    expect(g.maxResident).toBe(3);
  });

  test("a relayed viewport with no room for old+new even downscaled reports too many when straddled", () => {
    const g = resolveGeometry({ cols: 24000, rows: 3 }, cell, relayed);
    expect(g.renderScale).toBe(1);
    expect<number>(g.tileHeightPx).toBe(2 * cell.cellHpx);
    expect(g.exceedsFrameLimit).toBe(false);
    expect(g.exceedsStorage).toBe(true);
    expect(g.maxResident).toBe(3);
    expect(g.maxResident).toBeLessThanOrEqual(g.maxTotalResident);
  });

  test("a directly connected terminal keeps single-generation displayable instead of overflowing", () => {
    const g = resolveGeometry({ cols: 723, rows: 201 }, cell, direct);
    expect(g.renderScale).toBe(2);
    expect<number>(g.tileHeightPx).toBe(1550);
    expect(g.exceedsFrameLimit).toBe(false);
    expect(g.exceedsStorage).toBe(true);
    expect(g.maxResident).toBe(5);
    expect(g.maxResident).toBeLessThanOrEqual(g.maxTotalResident);
  });

  test("an odd one-row viewport stays full resolution when reduced scrolling cannot reach its tail", () => {
    const g = resolveGeometry(
      { cols: 10000, rows: 2 },
      { cellHpx: 997, cellWpx: 1 },
      relayed,
    );
    expect(g.renderScale).toBe(2);
  });

  test("an even one-row viewport may downscale because its scroll unit still fits", () => {
    const g = resolveGeometry(
      { cols: 8000, rows: 2 },
      { cellHpx: 1000, cellWpx: 1 },
      relayed,
    );
    expect(g.renderScale).toBe(1);
    expect(g.exceedsFrameLimit).toBe(false);
  });

  test("400x200 stores one generation when old+new would overflow, keeping budgets consistent", async () => {
    const { fitsGraphicsFrame, maxTilesInFrame } = await import("./capacity.ts");
    const { toImagePx } = await import("./viewport.ts");
    const g = resolveGeometry({ cols: 400, rows: 200 }, cell, relayed);
    expect(g.exceedsFrameLimit).toBe(false);
    expect(g.exceedsStorage).toBe(true);
    expect(g.maxResident).toBeLessThanOrEqual(g.maxTotalResident);
    const viewportH = 199 * cell.cellHpx;
    const tilesInFrame = maxTilesInFrame(viewportH, g.tileHeightPx);
    const tileBytes = g.imgWidthPx * toImagePx(g.tileHeightPx, g.renderScale) * 4;
    expect(fitsGraphicsFrame(relayed, g.imgWidthPx, toImagePx(g.tileHeightPx, g.renderScale))).toBe(
      true,
    );
    expect(tilesInFrame * tileBytes).toBeLessThanOrEqual(relayed.storageBytes);
    expect(g.maxTotalResident * tileBytes).toBeLessThanOrEqual(relayed.storageBytes);
  });

  test("a direct 300x201 update after a scroll fits old+new visible tiles in real storage", async () => {
    const { maxTilesInFrame } = await import("./capacity.ts");
    const { toImagePx } = await import("./viewport.ts");
    const g = resolveGeometry({ cols: 300, rows: 201 }, cell, direct);
    const viewportH = 200 * cell.cellHpx;
    const tilesInFrame = maxTilesInFrame(viewportH, g.tileHeightPx);
    const tileBytes = g.imgWidthPx * toImagePx(g.tileHeightPx, g.renderScale) * 4;
    expect(2 * tilesInFrame * tileBytes).toBeLessThanOrEqual(320_000_000);
    expect(g.maxTotalResident * tileBytes).toBeLessThanOrEqual(320_000_000);
  });
});
