import { describe, expect, test } from "bun:test";
import { renderFrame, sanitizeTerminalBlock, sanitizeTerminalLine, truncateToDisplayWidth } from "./frame.ts";
import { alignedTileHeightPx, computeTiles } from "./viewport.ts";
import type { ViewState } from "./scheduler.ts";

const ESC = "\x1b";
const TILE_HEIGHT = alignedTileHeightPx(10, 50);

function makeView(): ViewState {
  const { tiles, contentHeightPx } = computeTiles(300, 10, 50, TILE_HEIGHT);
  return {
    geometry: {
      rows: 51,
      cols: 80,
      cellHpx: 10,
      imgWidthPx: 800,
      viewportWidthCssPx: 400,
      renderScale: 2,
      tileHeightPx: TILE_HEIGHT,
      exceedsFrameLimit: false,
      exceedsStorage: false,
      maxResident: 64,
      maxTotalResident: 128,
    },
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

function reducedView(): ViewState {
  const { tiles, contentHeightPx } = computeTiles(3000, 10, 50, TILE_HEIGHT);
  return {
    geometry: {
      rows: 51,
      cols: 80,
      cellHpx: 10,
      imgWidthPx: 400,
      viewportWidthCssPx: 400,
      renderScale: 1,
      tileHeightPx: TILE_HEIGHT,
      exceedsFrameLimit: false,
      exceedsStorage: false,
      maxResident: 64,
      maxTotalResident: 128,
    },
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
  });
});

describe("source rect when downscaled", () => {
  test("source rect scales and capacity wins over low-res", () => {
    const { escape } = renderFrame(reducedView(), "a.md", []);
    expect(escape).toContain("h=250");
    expect(escape).toContain("low-res");
    expect(renderFrame(makeView(), "a.md", []).escape).toContain("h=300");
    const v = reducedView();
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

describe("sanitizeTerminalBlock", () => {
  test("keeps newlines/tabs, neutralizes other controls", () => {
    expect(sanitizeTerminalBlock(`Error: ${ESC}[31mx${ESC}[0m\n  at f\t(a.ts)\r`)).toBe(
      "Error: ?[31mx?[0m\n  at f\t(a.ts)?",
    );
    expect(sanitizeTerminalBlock("café❤️.md")).toBe("café❤️.md");
  });
});

describe("sanitizeTerminalLine", () => {
  test("neutralizes newlines/tabs for single-line display", () => {
    expect(sanitizeTerminalLine("a\nb\tc.md")).toBe("a?b?c.md");
    expect(statusLine("a\nb\tc.md")).not.toContain("\n");
    expect(statusLine("a\nb\tc.md")).not.toContain("\t");
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

  test("VS16 emoji is one grapheme", () => {
    expect(truncateToDisplayWidth("❤️", 2)).toEqual({ text: "❤️", displayWidth: 2 });
    expect(truncateToDisplayWidth("❤️", 1)).toEqual({ text: "", displayWidth: 0 });
  });

  test("no split on full-width boundary", () => {
    expect(truncateToDisplayWidth("０１２", 5)).toEqual({ text: "０１", displayWidth: 4 });
    expect(truncateToDisplayWidth("abc", 2)).toEqual({ text: "ab", displayWidth: 2 });
  });
});
