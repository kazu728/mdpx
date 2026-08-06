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
});
