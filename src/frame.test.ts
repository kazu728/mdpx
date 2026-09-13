import { describe, expect, test } from "bun:test";
import { renderFrame } from "./frame.ts";
import { alignedTileHeightPx, computeTiles, SCROLL_TOP } from "./viewport.ts";
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
    scrollPx: SCROLL_TOP,
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

describe("renderFrame", () => {
  test("a normal frame's output contains no CSI 2J", () => {
    const { escape } = renderFrame(makeView(), "SPEC.md", []);
    expect(escape).not.toContain(`${ESC}[2J`);
  });

  test("home and CSI 0J follow the deletion of the old placements", () => {
    const first = renderFrame(makeView(), "SPEC.md", []);
    const { escape } = renderFrame(makeView(), "SPEC.md", first.placements);

    const del = escape.indexOf("a=d,d=i");
    const clear = escape.indexOf(`${ESC}[H${ESC}[J`);

    expect(del).toBeGreaterThanOrEqual(0);
    expect(clear).toBeGreaterThan(del);
  });

  test("the placement command for a transferred tile comes after the screen erase", () => {
    const { escape } = renderFrame(makeView(), "SPEC.md", []);

    const erase = escape.indexOf(`${ESC}[J`);
    const place = escape.indexOf("a=p,");

    expect(erase).toBeGreaterThanOrEqual(0);
    expect(place).toBeGreaterThan(erase);
  });
});

function statusLine(filename: string, cols = 80): string {
  const view = makeView();
  const { escape } = renderFrame({ ...view, geometry: { ...view.geometry, cols } }, filename, []);
  const m = escape.match(/\x1b\[7m([\s\S]*)\x1b\[0m/);
  expect(m).not.toBeNull();
  return m![1]!;
}

describe("status bar", () => {
  test("the display width is exactly cols for any file name (no wrap shifting the screen by a row)", () => {
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

describe("source rect when downscaled", () => {
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
      scrollPx: SCROLL_TOP,
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

  test("the source rect is half the screen px while the cell count is unchanged", () => {
    const { escape } = renderFrame(reducedView(), "a.md", []);
    expect(escape).toContain("h=250");
    expect(escape).toContain("r=50");
    expect(escape).toContain("w=400");
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
    const over = { ...v, geometry: { ...v.geometry, exceedsFrameLimit: true } };
    const { escape } = renderFrame(over, "a.md", []);
    expect(escape).toContain("too wide");
    expect(escape).not.toContain("low-res");
  });

  test("storage-only overflow is distinguished as \"too many\" (never passed off as low-res)", () => {
    const v = reducedView();
    const over = {
      ...v,
      geometry: { ...v.geometry, exceedsFrameLimit: false, exceedsStorage: true },
    };
    const { escape } = renderFrame(over, "a.md", []);
    expect(escape).toContain("too many");
    expect(escape).not.toContain("low-res");
    expect(escape).not.toContain("too wide");
  });

  test("transfer overflow takes precedence over storage overflow", () => {
    const v = reducedView();
    const over = {
      ...v,
      geometry: { ...v.geometry, exceedsFrameLimit: true, exceedsStorage: true },
    };
    const { escape } = renderFrame(over, "a.md", []);
    expect(escape).toContain("too wide");
    expect(escape).not.toContain("too many");
  });
});

describe("failure status", () => {
  test("a failed first render is distinguished from an empty document", () => {
    const v = makeView();
    const failed: ViewState = { ...v, displayGen: null, failure: true };
    const { escape } = renderFrame(failed, "a.md", []);
    expect(escape).toContain("render failed");
    const clean = renderFrame({ ...failed, failure: false }, "a.md", []);
    expect(clean.escape).not.toContain("render failed");
  });

  test("a failed update keeps the old placements and reports the failure", () => {
    const v = makeView();
    const { escape } = renderFrame({ ...v, failure: true }, "a.md", []);
    expect(escape).toContain("update failed");
    // The displayed tiles are still placed; only the status changes.
    expect(escape).toContain("a=p,");
  });

  test("an in-flight retry reports activity instead of the settled failure", () => {
    const v = makeView();
    const { escape } = renderFrame({ ...v, failure: true, phase: "rendering" }, "a.md", []);
    expect(escape).toContain("updating");
    expect(escape).not.toContain("update failed");
  });
});
