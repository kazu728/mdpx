import { describe, expect, test } from "bun:test";
import { GUTTER_COLS, resolveGeometry } from "./geometry.ts";
import { deletePlacement, place } from "./kitty.ts";
import { buildLayout, cropOf, visiblePlacements, type Layout, type SyncedLayout } from "./layout.ts";
import type { ResidentImage, ViewState } from "./scheduler.ts";
import { renderFrame } from "./screen.ts";
import { GEO } from "./test-geometry.ts";

const ESC = "\x1b";

function layoutOf(keys: string[], g = GEO, theme: "light" | "dark" = "light"): Layout {
  let y = 32;
  const blocks = keys.map((key, i) => {
    if (i > 0) y += 16;
    const b = { key, topCss: y, heightCss: 60 };
    y += 60;
    return b;
  });
  const synced: SyncedLayout = { raster: g.raster, theme, blocks, docHeightCss: y + 32 };
  return buildLayout(synced, g);
}

function view(shown: Layout | null, overrides: Partial<ViewState> = {}): ViewState {
  const images = new Map<string, ResidentImage>();
  let id = 100;
  for (const key of shown?.slices.keys() ?? []) images.set(key, { id: id++, contentTopImgPx: 30, heightImgPx: 400 });
  return {
    geometry: GEO,
    shown,
    top: 0,
    images,
    marks: new Set(),
    follow: false,
    status: "idle",
    target: null,
    ...overrides,
  };
}

function statusLine(v: ViewState, filename = "a.md"): string {
  return renderFrame(v, filename, []).escape.match(/\x1b\[7m(.*)\x1b\[0m/s)![1]!;
}

describe("renderFrame", () => {
  test("replaces the previous placements and paints the page behind them, keeping the stored images", () => {
    const v = view(layoutOf(["a", "b"]));
    const first = renderFrame(v, "a.md", []);
    expect(first.placements).toEqual([
      { id: 100, placementId: 1 },
      { id: 101, placementId: 1 },
    ]);
    const { escape } = renderFrame(v, "a.md", first.placements);
    expect(escape.startsWith(`${ESC}[?2026h`)).toBe(true);
    expect(escape.endsWith(`${ESC}[?2026l`)).toBe(true);
    expect(escape).not.toContain(`${ESC}[2J`);
    expect(escape).not.toContain("d=I");
    const erase = escape.indexOf(`${ESC}[H${ESC}[48;2;255;255;255m${ESC}[J`);
    expect(erase).toBeGreaterThan(-1);
    expect(escape.indexOf(deletePlacement(100, 1))).toBeLessThan(erase);
    expect(escape.indexOf("a=p,")).toBeGreaterThan(erase);
  });

  test("each slice is cropped to its rows and placed right of the gutter", () => {
    const shown = layoutOf(["a", "b", "c"]);
    const v = view(shown, { top: 3 });
    const { escape } = renderFrame(v, "a.md", []);
    for (const p of visiblePlacements(shown, 3, GEO.viewRows)) {
      const image = v.images.get(p.imageKey)!;
      const crop = cropOf(p, image);
      expect(escape).toContain(
        `${ESC}[${p.screenRow + 1};${GUTTER_COLS + 1}H` +
          place({
            id: image.id,
            placementId: 1,
            sourceXImagePx: 0,
            sourceYImagePx: crop.y,
            sourceWidthImagePx: GEO.imgWidthPx,
            sourceHeightImagePx: crop.h,
            displayColumns: GEO.raster.contentCols,
            displayRows: p.rows,
          }),
      );
    }
  });

  test("identical blocks share one image with separate placements; missing images leave the page showing", () => {
    const shown = layoutOf(["same", "x", "same"]);
    const v = view(shown);
    expect(renderFrame(v, "a.md", []).placements.filter((p) => p.id === 100)).toEqual([
      { id: 100, placementId: 1 },
      { id: 100, placementId: 2 },
    ]);
    const without = view(shown, { images: new Map() });
    expect(renderFrame(without, "a.md", []).escape).not.toContain("a=p,");
  });

  test("changed blocks are marked in the gutter, on the page's background", () => {
    const shown = layoutOf(["a", "b"]);
    const plain = renderFrame(view(shown), "a.md", []).escape;
    expect(plain).not.toContain("▎");
    const marked = renderFrame(view(shown, { marks: new Set(["b"]) }), "a.md", []).escape;
    const bRows = visiblePlacements(shown, 0, GEO.viewRows).filter((p) => p.unit === 1);
    for (const p of bRows) {
      for (let r = 0; r < p.rows; r++) expect(marked).toContain(`${ESC}[${p.screenRow + r + 1};1H▎`);
    }
  });

  test("the dark theme paints the dark page background", () => {
    const { escape } = renderFrame(view(layoutOf(["a"], GEO, "dark")), "a.md", []);
    expect(escape).toContain(`${ESC}[48;2;13;17;23m${ESC}[J`);
  });
});

describe("status bar", () => {
  test("fills exactly the terminal width, dropping q:quit when it does not fit", () => {
    const wide = statusLine(view(layoutOf(["a"])), "👨‍👩‍👧.md");
    expect(Bun.stringWidth(wide)).toBe(GEO.cols);
    expect(wide.endsWith("q:quit")).toBe(true);
    const narrowGeo = resolveGeometry({ cols: 12, rows: 51 }, { cellHpx: 20, cellWpx: 10 });
    const narrow = statusLine(view(layoutOf(["a"]), { geometry: narrowGeo }), "a".repeat(40) + ".md");
    expect(Bun.stringWidth(narrow)).toBe(12);
    expect(narrow).not.toContain("q:quit");
  });

  test("never splits a grapheme or a full-width character in the file name", () => {
    const g = resolveGeometry({ cols: 5, rows: 51 }, { cellHpx: 20, cellWpx: 10 });
    expect(statusLine(view(layoutOf(["a"]), { geometry: g }), "❤️０１２.md")).toBe("❤️０ ");
  });

  test("control characters in the file name are neutralized", () => {
    expect(statusLine(view(layoutOf(["a"])), `x${ESC}[31m\n\t.md`).startsWith("x?[31m??.md")).toBe(true);
  });

  test("shows what the scheduler is doing, following and low resolution", () => {
    const shown = view(layoutOf(["a"]));
    expect(statusLine({ ...shown, status: "scrolling" })).toContain("scrolling…");
    expect(statusLine({ ...shown, status: "updating" })).toContain("updating");
    expect(statusLine({ ...shown, shown: null, status: "rendering" })).toContain("rendering…");
    expect(statusLine({ ...shown, status: "update failed" })).toContain("update failed");
    expect(statusLine({ ...shown, follow: true })).toContain("follow");
    const low = resolveGeometry({ cols: 400, rows: 120 }, { cellHpx: 40, cellWpx: 20 }, { frameBytes: 30 * 2 ** 20, storageBytes: 64 * 2 ** 20 });
    expect(statusLine(view(null, { geometry: low }))).toContain("low-res");
    expect(statusLine(shown)).not.toContain("low-res");
  });
});
