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

  test("the measured relayed geometry keeps one directional read-ahead tile resident", () => {
    const g = resolveGeometry({ cols: 216, rows: 65 }, cell, relayed);
    expect(g.renderScale).toBe(2);
    expect<number>(g.tileHeightPx).toBe(32 * cell.cellHpx);
    expect(g.maxResident).toBe(4);
    expect(g.exceedsFrameLimit).toBe(false);
  });

  test("a width that does not fit the relay frame downscales, halving imgWidthPx too", () => {
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

  test("a width that does not fit even downscaled reports the frame overflow", () => {
    const g = resolveGeometry({ cols: 2000, rows: 65 }, cell, relayed);
    expect(g.renderScale).toBe(1);
    expect(g.exceedsFrameLimit).toBe(true);
  });

  test("a relayed viewport with no room for a read-ahead tile still stays full resolution", () => {
    const g = resolveGeometry({ cols: 6000, rows: 3 }, cell, relayed);
    expect(g.renderScale).toBe(2);
    expect<number>(g.tileHeightPx).toBe(2 * cell.cellHpx);
    expect(g.exceedsFrameLimit).toBe(false);
    expect(g.maxResident).toBe(2);
  });

  test("a relayed viewport with no room for a read-ahead tile even downscaled still downscales", () => {
    const g = resolveGeometry({ cols: 24000, rows: 3 }, cell, relayed);
    expect(g.renderScale).toBe(1);
    expect<number>(g.tileHeightPx).toBe(2 * cell.cellHpx);
    expect(g.exceedsFrameLimit).toBe(false);
    expect(g.maxResident).toBe(2);
  });

  test("a directly connected terminal drops the read-ahead tile rather than the two visible ones", () => {
    const g = resolveGeometry({ cols: 723, rows: 201 }, cell, direct);
    expect(g.renderScale).toBe(2);
    expect<number>(g.tileHeightPx).toBe(4092);
    expect(g.exceedsFrameLimit).toBe(false);
    expect(g.maxResident).toBe(3);
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
});
