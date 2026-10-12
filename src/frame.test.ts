import { describe, expect, test } from "bun:test";
import { renderFrame, truncateToDisplayWidth } from "./frame.ts";
import type { Geometry } from "./geometry.ts";
import { deletePlacement, imageId, place } from "./kitty.ts";
import type { ViewState } from "./scheduler.ts";
import { GEO } from "./test-geometry.ts";
import { computeTiles, contentRows } from "./viewport.ts";

const ESC = "\x1b";
const REDUCED: Geometry = { ...GEO, imgWidthPx: 400, renderScale: 1 };

function view(documentHeightPx: number, overrides: Partial<ViewState> = {}): ViewState {
  const geometry = overrides.geometry ?? GEO;
  const { tiles, contentHeightPx } = computeTiles(
    documentHeightPx,
    geometry.cellHpx,
    contentRows(geometry.rows),
    geometry.tileHeightPx,
  );
  return {
    geometry,
    scrollPx: 0,
    phase: "ready",
    failure: false,
    pendingScrollPx: null,
    displayGen: { gen: 1, tiles, resident: new Set(tiles.keys()), truncated: false, contentHeightPx },
    ...overrides,
  };
}

function statusLine(v: ViewState, filename = "a.md"): string {
  return renderFrame(v, filename, []).escape.match(/\x1b\[7m(.*)\x1b\[0m/s)![1]!;
}

describe("renderFrame", () => {
  test("replaces the previous placements without clearing the stored images", () => {
    const first = renderFrame(view(300), "a.md", []);
    expect(first.placements).toEqual([imageId(1, 0)]);
    expect(first.escape).toContain("x=0,y=0,w=800,h=300,c=80,r=30");
    const { escape } = renderFrame(view(300), "a.md", first.placements);
    expect(escape.startsWith(`${ESC}[?2026h`)).toBe(true);
    expect(escape.endsWith(`${ESC}[?2026l`)).toBe(true);
    expect(escape).not.toContain(`${ESC}[2J`);
    expect(escape).not.toContain("d=I");
    const erase = escape.indexOf(`${ESC}[H${ESC}[J`);
    const unplace = escape.indexOf(deletePlacement(imageId(1, 0)));
    expect(unplace).toBeGreaterThan(-1);
    expect(unplace).toBeLessThan(erase);
    expect(escape.indexOf("a=p,")).toBeGreaterThan(erase);
  });

  test("crops tiles in image pixels when the capture is downscaled", () => {
    const { escape } = renderFrame(view(3000, { geometry: REDUCED, scrollPx: 520 }), "a.md", []);
    const crop = (tileIndex: number, y: number, h: number, rows: number) =>
      place({
        id: imageId(1, tileIndex),
        sourceXImagePx: 0,
        sourceYImagePx: y,
        sourceWidthImagePx: 400,
        sourceHeightImagePx: h,
        displayColumns: 80,
        displayRows: rows,
      });
    expect(escape).toContain(`${ESC}[1;1H${crop(1, 10, 240, 48)}`);
    expect(escape).toContain(`${ESC}[49;1H${crop(2, 0, 10, 2)}`);
  });
});

describe("status bar", () => {
  test("fills exactly the terminal width, dropping q:quit when it does not fit", () => {
    const wide = statusLine(view(300), "👨‍👩‍👧.md");
    expect(Bun.stringWidth(wide)).toBe(GEO.cols);
    expect(wide.endsWith("q:quit")).toBe(true);
    const narrow = statusLine(view(300, { geometry: { ...GEO, cols: 12 } }), "a".repeat(40) + ".md");
    expect(Bun.stringWidth(narrow)).toBe(12);
    expect(narrow).not.toContain("q:quit");
  });

  test("control characters in the file name are neutralized", () => {
    expect(statusLine(view(300), `x${ESC}[31m\n\t.md`).startsWith("x?[31m??.md")).toBe(true);
  });

  test("shows activity before failure before truncation", () => {
    const shown = view(300);
    expect(statusLine({ ...shown, pendingScrollPx: 0, phase: "rendering", failure: true })).toContain("scrolling…");
    expect(statusLine({ ...shown, phase: "rendering", failure: true })).toContain("updating");
    expect(statusLine({ ...shown, displayGen: null, phase: "rendering" })).toContain("rendering…");
    expect(statusLine({ ...shown, displayGen: null, failure: true })).toContain("render failed");
    const long = view(3000);
    const truncated = { ...long, displayGen: { ...long.displayGen!, truncated: true } };
    expect(statusLine({ ...truncated, scrollPx: 2500 })).toContain("truncated");
    expect(statusLine({ ...truncated, scrollPx: 2490 })).not.toContain("truncated");
  });

  test("capacity warnings outrank low resolution", () => {
    const reduced = view(300, { geometry: REDUCED });
    const capacity = (g: Partial<Geometry>) => statusLine({ ...reduced, geometry: { ...REDUCED, ...g } });
    expect(capacity({})).toContain("low-res");
    expect(capacity({ exceedsStorage: true })).toContain("too many");
    expect(capacity({ exceedsStorage: true })).not.toContain("low-res");
    expect(capacity({ exceedsFrameLimit: true, exceedsStorage: true })).toContain("too wide");
    expect(capacity({ exceedsFrameLimit: true, exceedsStorage: true })).not.toContain("too many");
  });
});

describe("truncateToDisplayWidth", () => {
  test("never splits a grapheme or a full-width character", () => {
    expect(truncateToDisplayWidth("❤️", 2)).toEqual({ text: "❤️", displayWidth: 2 });
    expect(truncateToDisplayWidth("❤️", 1)).toEqual({ text: "", displayWidth: 0 });
    expect(truncateToDisplayWidth("０１２", 5)).toEqual({ text: "０１", displayWidth: 4 });
  });
});
