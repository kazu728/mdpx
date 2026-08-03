// Regression tests for a normal frame's erase sequence. renderFrame erases with HOME + CSI 0J and
// must never send CSI 2J (why: CLEAR_SCREEN in term.ts).

import { describe, expect, test } from "bun:test";
import { renderFrame } from "./frame.ts";
import { computeTiles } from "./viewport.ts";
import type { ViewState } from "./scheduler.ts";

const ESC = "\x1b";

/** The smallest ViewState where tile 0 is transferred and visible (yielding exactly one placement command). */
function makeView(): ViewState {
  const { tiles, contentHpx } = computeTiles(300, 10, 50);
  return {
    geometry: { rows: 51, cols: 80, cellHpx: 10, imgWidthPx: 800, cssWidth: 400, renderScale: 2, relayOverflow: false, maxResident: 64 },
    scrollPx: 0,
    displayGen: 1,
    tiles,
    resident: new Set([0]),
    truncated: false,
    contentHpx,
    phase: "ready",
  };
}

describe("renderFrame", () => {
  test("a normal frame's output contains no CSI 2J", () => {
    const { escape } = renderFrame(makeView(), "SPEC.md", []);
    expect(escape).not.toContain(`${ESC}[2J`);
  });

  test("home and CSI 0J follow the deletion of the old placements", () => {
    // Passing the previous frame's placement IDs emits the delete commands at the head of the next frame.
    const first = renderFrame(makeView(), "SPEC.md", []);
    const { escape } = renderFrame(makeView(), "SPEC.md", first.placements);

    const del = escape.indexOf("a=d,d=i"); // deletePlacement
    const clear = escape.indexOf(`${ESC}[H${ESC}[J`); // HOME + CSI 0J (emitted adjacently)

    expect(del).toBeGreaterThanOrEqual(0);
    expect(clear).toBeGreaterThan(del); // home and erase-below come after the deletion
  });

  test("the placement command for a transferred tile comes after the screen erase", () => {
    const { escape } = renderFrame(makeView(), "SPEC.md", []);

    const erase = escape.indexOf(`${ESC}[J`);
    const place = escape.indexOf("a=p,"); // place

    expect(erase).toBeGreaterThanOrEqual(0);
    expect(place).toBeGreaterThan(erase);
  });
});

/** Extract only the status bar (the reverse-video last row). */
function statusLine(filename: string, cols = 80): string {
  const view = makeView();
  const { escape } = renderFrame({ ...view, geometry: { ...view.geometry, cols } }, filename, []);
  const m = escape.match(/\x1b\[7m([\s\S]*)\x1b\[0m/);
  expect(m).not.toBeNull();
  return m![1]!;
}

describe("status bar", () => {
  test("the display width is exactly cols for any file name (no wrap shifting the screen by a row)", () => {
    // Measured anywhere but per grapheme, a VS16 emoji splits into widths 1 and 2, the padding goes
    // negative, and String.prototype.repeat throws a RangeError (leaving the terminal in alt-screen)
    const names = ["SPEC.md", "❤️README.md", "⚠️a.md", "ℹ️.md", "👨‍👩‍👧.md", "０".repeat(60) + ".md"];
    for (const name of names) {
      for (const cols of [10, 20, 25, 40, 80]) {
        expect(Bun.stringWidth(statusLine(name, cols))).toBe(cols);
      }
    }
    expect(Bun.stringWidth(statusLine("❤️" + "a".repeat(62) + ".md", 80))).toBe(80);
  });

  test("q:quit goes at the right edge when there is room", () => {
    expect(statusLine("SPEC.md", 80).endsWith("q:quit")).toBe(true);
  });

  test("without room, q:quit is dropped and only the left side remains", () => {
    const line = statusLine("a".repeat(40) + ".md", 12);
    expect(line).not.toContain("q:quit");
    expect(Bun.stringWidth(line)).toBe(12);
  });

  test("control characters in a file name are neutralized before reaching the terminal", () => {
    const line = statusLine(`x${ESC}[31mred.md`);
    expect(line).not.toContain(`${ESC}[31m`);
    expect(line.startsWith("x?[31mred.md")).toBe(true);
  });
});

describe("source rect when downscaled (§4.8)", () => {
  /** renderScale=1: the image is half in both directions. The source rect halves too; the cell count does not. */
  function reducedView(): ViewState {
    const { tiles, contentHpx } = computeTiles(3000, 10, 50);
    return {
      geometry: { rows: 51, cols: 80, cellHpx: 10, imgWidthPx: 400, cssWidth: 400, renderScale: 1, relayOverflow: false, maxResident: 64 },
      scrollPx: 0,
      displayGen: 1,
      tiles,
      resident: new Set([0]),
      truncated: false,
      contentHpx,
      phase: "ready",
    };
  }

  test("the source rect is half the screen px while the cell count is unchanged", () => {
    const { escape } = renderFrame(reducedView(), "a.md", []);
    // The visible area is 500 screen px (contentRows=50 × cellHpx=10) → 250 in image px
    expect(escape).toContain("h=250");
    expect(escape).toContain("r=50"); // cell counts are a screen-side unit and are not converted
    expect(escape).toContain("w=400"); // imgWidthPx is already in image px
  });

  test("at 1:1 the source rect matches the screen px", () => {
    const { escape } = renderFrame(makeView(), "a.md", []);
    expect(escape).toContain("h=300");
    expect(escape).toContain("r=30");
  });

  test("while downscaled the status bar shows \"low-res\"", () => {
    expect(renderFrame(reducedView(), "a.md", []).escape).toContain("low-res");
  });

  test("overflowing even downscaled is distinguished as \"too wide\" (never passed off as low-res)", () => {
    const v = reducedView();
    const over = { ...v, geometry: { ...v.geometry, relayOverflow: true } };
    const { escape } = renderFrame(over, "a.md", []);
    expect(escape).toContain("too wide");
    expect(escape).not.toContain("low-res");
  });
});
