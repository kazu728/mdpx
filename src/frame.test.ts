import { describe, expect, test } from "bun:test";
import { renderFrame, truncateToDisplayWidth } from "./frame.ts";
import { computeTiles, contentRows } from "./viewport.ts";
import type { Geometry } from "./geometry.ts";
import type { ViewState } from "./scheduler.ts";
import { GEO } from "./test-geometry.ts";

const ESC = "\x1b";
const FULL: Geometry = { ...GEO, cols: 80, imgWidthPx: 800, viewportWidthCssPx: 400 };
const REDUCED: Geometry = { ...FULL, imgWidthPx: 400, renderScale: 1 };

function makeView(geometry: Geometry = FULL, documentHeightPx = 300): ViewState {
  const { tiles, contentHeightPx } = computeTiles(
    documentHeightPx,
    geometry.cellHpx,
    contentRows(geometry.rows),
    geometry.tileHeightPx,
  );
  return {
    geometry,
    scrollPx: 0,
    displayGen: 1,
    tiles,
    resident: new Set([0]),
    truncated: false,
    contentHeightPx,
    phase: "ready",
    failure: false,
    pendingScrollPx: null,
  };
}

function statusLine(filename: string, cols = 80): string {
  const view = makeView();
  const { escape } = renderFrame({ ...view, geometry: { ...view.geometry, cols } }, filename, []);
  const m = escape.match(/\x1b\[7m([\s\S]*)\x1b\[0m/);
  expect(m).not.toBeNull();
  return m![1]!;
}

describe("renderFrame", () => {
  test("erase/placement order without CSI 2J", () => {
    const first = renderFrame(makeView(), "SPEC.md", []);
    expect(first.escape).not.toContain(`${ESC}[2J`);
    const { escape } = renderFrame(makeView(), "SPEC.md", first.placements);
    const del = escape.indexOf("a=d,d=i");
    expect(del).toBeGreaterThanOrEqual(0);
    const erase = escape.indexOf(`${ESC}[H${ESC}[J`);
    expect(erase).toBeGreaterThan(del);
    expect(escape.indexOf("a=p,")).toBeGreaterThan(escape.indexOf(`${ESC}[J`));
  });
});

describe("status bar", () => {
  test("width is exactly cols with q:quit and sanitized names", () => {
    for (const name of ["SPEC.md", "👨‍👩‍👧.md"])
      for (const cols of [12, 80]) expect(Bun.stringWidth(statusLine(name, cols))).toBe(cols);
    expect(statusLine("SPEC.md", 80).endsWith("q:quit")).toBe(true);
    expect(statusLine("a".repeat(40) + ".md", 12)).not.toContain("q:quit");
    const line = statusLine(`x${ESC}[31mred.md`);
    expect(line).not.toContain(`${ESC}[31m`);
    expect(line.startsWith("x?[31mred.md")).toBe(true);
    expect(statusLine("a\nb\tc.md")).not.toContain("\n");
    expect(statusLine("a\nb\tc.md")).not.toContain("\t");
  });
});

describe("source rect when downscaled", () => {
  test("source rect scales and capacity wins over low-res", () => {
    const { escape } = renderFrame(makeView(REDUCED, 3000), "a.md", []);
    expect(escape).toContain("h=250");
    expect(escape).toContain("low-res");
    expect(renderFrame(makeView(), "a.md", []).escape).toContain("h=300");
    const v = makeView(REDUCED, 3000);
    for (const exceeds of [
      { exceedsFrameLimit: true, exceedsStorage: false },
      { exceedsFrameLimit: true, exceedsStorage: true },
      { exceedsFrameLimit: false, exceedsStorage: true },
    ]) {
      const { escape: e } = renderFrame({ ...v, geometry: { ...v.geometry, ...exceeds } }, "a.md", []);
      expect(e).toContain(exceeds.exceedsFrameLimit ? "too wide" : "too many");
      expect(e).not.toContain("low-res");
    }
  });
});

describe("failure status", () => {
  test("failure vs in-flight activity", () => {
    const v = makeView();
    const failed: ViewState = { ...v, displayGen: null, failure: true };
    expect(renderFrame(failed, "a.md", []).escape).toContain("render failed");
    expect(renderFrame({ ...v, failure: true }, "a.md", []).escape).toContain("update failed");
    expect(
      renderFrame({ ...v, failure: true, phase: "rendering" }, "a.md", []).escape,
    ).toContain("updating");
  });
});

describe("truncateToDisplayWidth", () => {
  test("width matches and never exceeds max", () => {
    for (const s of ["❤️README.md", "⚠️a", "ℹ️", "０１２", "👨‍👩‍👧x", "plain.md"]) {
      for (let max = 0; max <= 12; max++) {
        const { text, displayWidth } = truncateToDisplayWidth(s, max);
        expect(displayWidth).toBeLessThanOrEqual(max);
        expect(Bun.stringWidth(text)).toBe(displayWidth);
      }
    }
  });

  test("never splits a grapheme or a full-width char", () => {
    expect(truncateToDisplayWidth("❤️", 2)).toEqual({ text: "❤️", displayWidth: 2 });
    expect(truncateToDisplayWidth("❤️", 1)).toEqual({ text: "", displayWidth: 0 });
    expect(truncateToDisplayWidth("０１２", 5)).toEqual({ text: "０１", displayWidth: 4 });
    expect(truncateToDisplayWidth("abc", 2)).toEqual({ text: "ab", displayWidth: 2 });
  });
});
