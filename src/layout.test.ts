import { describe, expect, test } from "bun:test";
import { CELL_CSS_PX, captureClipCss, resolveGeometry, screenImageBytes, type Geometry } from "./geometry.ts";
import {
  anchorAt,
  buildLayout,
  cropOf,
  headingRows,
  maxTop,
  prefetchOrder,
  topFor,
  visiblePlacements,
  type CapturedImage,
  type Layout,
  type Slice,
  type SyncedLayout,
} from "./layout.ts";
import type { BlockKind } from "./markdown.ts";
import { GEO } from "./test-geometry.ts";

interface Spec {
  key: string;
  height: number;
  gap?: number;
  kind?: BlockKind;
}

/** Stacks blocks the way the page does: 32px of article padding, then each block after its gap. */
function synced(specs: Spec[], g: Geometry = GEO): SyncedLayout {
  let y = 32;
  const blocks = specs.map((s, i) => {
    if (i > 0) y += s.gap ?? 16;
    const block = { key: s.key, kind: s.kind ?? "other", topCss: y, heightCss: s.height };
    y += s.height;
    return block;
  });
  return { raster: g.raster, theme: "light", blocks, docHeightCss: y + 32 };
}

function layoutOf(specs: Spec[], g: Geometry = GEO): Layout {
  return buildLayout(synced(specs, g), g);
}

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function randomSpecs(random: () => number, count: number): Spec[] {
  return Array.from({ length: count }, (_, i) => ({
    key: `b${Math.floor(random() * count)}`,
    height: Math.round(random() * 400 * 100) / 100 + 0.5,
    gap: random() < 0.15 ? Math.round(random() * 15 * 100) / 100 : 16 + Math.round(random() * 24 * 100) / 100,
    kind: random() < 0.2 ? "heading" : "other",
  }));
}

/** What the page captures for a slice of a unit whose top is at `unitTopCss` (see Page.capture). */
function captureAt(slice: Slice, unitTopCss: number, g: Geometry): CapturedImage & { contentTopCss: number; topCss: number } {
  const contentTopCss = unitTopCss + slice.capture.offsetCss;
  const { topCss, bottomCss } = captureClipCss(contentTopCss, slice.capture.lengthCss, g.deviceScaleFactor);
  return {
    contentTopCss,
    topCss,
    contentTopImgPx: (contentTopCss - topCss) * g.deviceScaleFactor,
    heightImgPx: Math.round((bottomCss - topCss) * g.deviceScaleFactor),
  };
}

const GEOMETRIES = [
  GEO,
  resolveGeometry({ cols: 120, rows: 40 }, { cellHpx: 27, cellWpx: 13 }, { frameBytes: null, storageBytes: 320_000_000 }),
  resolveGeometry({ cols: 400, rows: 120 }, { cellHpx: 41, cellWpx: 20 }, { frameBytes: 30 * 2 ** 20, storageBytes: 64 * 2 ** 20 }),
];

describe("buildLayout", () => {
  test("blocks closer than one row share a unit; units never share a terminal row", () => {
    const l = layoutOf([
      { key: "a", height: 40 },
      { key: "b", height: 40, gap: 0 },
      { key: "c", height: 40, gap: 16 },
    ]);
    expect(l.units.map((u) => u.members.map((m) => m.key))).toEqual([["a", "b"], ["c"]]);

    for (const [seed, g] of GEOMETRIES.entries()) {
      const random = rng(seed + 1);
      for (let round = 0; round < 50; round++) {
        const units = layoutOf(randomSpecs(random, 30), g).units;
        for (let i = 1; i < units.length; i++) {
          expect(units[i]!.rowStart).toBeGreaterThanOrEqual(units[i - 1]!.rowEnd);
        }
      }
    }
  });

  test("a tall unit's slices cover its rows once, each inside one screenshot", () => {
    for (const g of GEOMETRIES) {
      const tallCss = g.raster.sliceRows * CELL_CSS_PX * 3.5;
      const unit = layoutOf([{ key: "tall", height: tallCss }], g).units[0]!;
      expect(unit.slices).toHaveLength(4);
      expect(unit.slices[0]!.rowStart).toBe(unit.rowStart);
      expect(unit.slices.at(-1)!.rowEnd).toBe(unit.rowEnd);
      for (let i = 1; i < unit.slices.length; i++) {
        expect(unit.slices[i]!.rowStart).toBe(unit.slices[i - 1]!.rowEnd);
      }
      for (const s of unit.slices) {
        for (const shift of [0, 3.3, 7.9, 15.99]) {
          const image = captureAt(s, unit.topScreenPx * (CELL_CSS_PX / g.raster.cellHpx) + shift, g);
          expect(g.imgWidthPx * image.heightImgPx * 4).toBeLessThanOrEqual(s.maxBytes);
          expect(image.heightImgPx).toBeLessThanOrEqual(4096);
        }
      }
    }
  });

  test("an image is keyed by its content and height, not by where it sits", () => {
    const before = layoutOf([{ key: "p", height: 50 }, { key: "x", height: 70 }]);
    const after = layoutOf([{ key: "new", height: 33.3 }, { key: "p", height: 50 }, { key: "x", height: 70 }]);
    const keys = (l: Layout) => l.units.flatMap((u) => u.slices.map((s) => s.imageKey));
    expect(keys(after)).toEqual(expect.arrayContaining(keys(before)));
    const grown = layoutOf([{ key: "p", height: 50 }, { key: "x", height: 90 }]);
    expect(keys(grown)[1]).not.toBe(keys(before)[1]);
  });

  test("document rows come from the page height", () => {
    const l = layoutOf([{ key: "a", height: 100 }]);
    expect(l.totalRows).toBe(Math.ceil(((32 + 100 + 32) * 20) / 16 / 20));
    expect(maxTop(l, GEO.viewRows)).toBe(0);
  });
});

describe("visiblePlacements", () => {
  test("a slice captured in one place shows the right page rows after its block moves, never past a row of page around it", () => {
    for (const [seed, g] of GEOMETRIES.entries()) {
      const random = rng(100 + seed);
      const { cellHpx, renderScale } = g.raster;
      const toCss = (screenPx: number) => (screenPx * CELL_CSS_PX) / cellHpx;
      for (let round = 0; round < 40; round++) {
        const specs = randomSpecs(random, 25);
        const before = layoutOf(specs, g);
        const after = layoutOf([{ key: "inserted", height: Math.round(random() * 300 * 100) / 100 + 1 }, ...specs], g);
        const top = Math.floor(random() * Math.max(1, after.totalRows));
        const rowsSeen = new Set<number>();
        for (const p of visiblePlacements(after, top, g.viewRows)) {
          for (let r = 0; r < p.rows; r++) {
            expect(rowsSeen.has(p.screenRow + r)).toBe(false);
            rowsSeen.add(p.screenRow + r);
          }
          expect(p.screenRow + p.rows).toBeLessThanOrEqual(g.viewRows);
          // No stretching: the crop is exactly as tall as the rows it fills, give or take rounding.
          expect(Math.abs(p.sourceHImgPx - p.rows * cellHpx * renderScale)).toBeLessThanOrEqual(1);
          const oldSlice = before.slices.get(p.imageKey);
          if (!oldSlice) continue;
          const oldUnit = before.units.find((u) => u.slices.includes(oldSlice))!;
          const image = captureAt(oldSlice, toCss(oldUnit.topScreenPx), g);
          const crop = cropOf(p, image);
          expect(crop.y).toBeGreaterThanOrEqual(0);
          expect(crop.y + crop.h).toBeLessThanOrEqual(image.heightImgPx);
          expect(Math.abs(crop.y - (image.contentTopImgPx + p.offsetImgPx))).toBeLessThanOrEqual(1);
          const shownTopCss = image.topCss + crop.y / g.deviceScaleFactor;
          const shownBottomCss = image.topCss + (crop.y + crop.h) / g.deviceScaleFactor;
          expect(shownTopCss).toBeGreaterThanOrEqual(image.contentTopCss - CELL_CSS_PX - 1);
          expect(shownBottomCss).toBeLessThanOrEqual(image.contentTopCss + oldSlice.capture.lengthCss + CELL_CSS_PX + 1);
        }
      }
    }
  });
});

describe("screenImageBytes", () => {
  test("no screen of blocks at least a row tall needs more image bytes than the bound", () => {
    const sliced = (g: Geometry, sliceRows: number): Geometry => ({ ...g, raster: { ...g.raster, sliceRows } });
    const screens = [...GEOMETRIES, sliced(GEO, 3), sliced(GEOMETRIES[1]!, 7)];
    for (const [seed, g] of screens.entries()) {
      const random = rng(500 + seed);
      const bound = screenImageBytes(g.imgWidthPx, g.raster, g.viewRows);
      for (let round = 0; round < 60; round++) {
        const specs = randomSpecs(random, 40).map((s) => ({ ...s, height: Math.max(CELL_CSS_PX, s.height) }));
        const l = layoutOf(specs, g);
        for (let top = 0; top < l.totalRows; top += 1 + Math.floor(random() * 5)) {
          const keys = new Set(visiblePlacements(l, top, g.viewRows).map((p) => p.imageKey));
          const bytes = [...keys].reduce((sum, k) => sum + l.slices.get(k)!.maxBytes, 0);
          expect(bytes).toBeLessThanOrEqual(bound);
        }
      }
    }
  });
});

describe("anchors", () => {
  const doc = Array.from({ length: 40 }, (_, i) => ({ key: `p${i}`, height: 60 }));

  test("text inserted above keeps the block at the top of the view where it was", () => {
    const before = layoutOf(doc);
    const top = before.units[20]!.rowStart + 1;
    const after = layoutOf([{ key: "new", height: 300 }, ...doc]);
    const kept = topFor(after, anchorAt(before, top), GEO.viewRows, top);
    expect(kept - after.units[21]!.rowStart).toBe(1);
  });

  test("a deleted anchor falls back to the old position; duplicates resolve to the nearest occurrence", () => {
    const before = layoutOf([...doc.slice(0, 10), { key: "dup", height: 60 }, ...doc.slice(10), { key: "dup", height: 60 }]);
    const lastDup = before.units.at(-1)!;
    const anchor = anchorAt(before, lastDup.rowStart)!;
    expect(anchor.block).toEqual({ key: "dup", occurrence: 1 });
    const removed = layoutOf(doc);
    expect(topFor(removed, anchorAt(before, 30), GEO.viewRows, 30)).toBe(30);
    expect(topFor(removed, { block: { key: "gone", occurrence: 0 }, offset: 0 }, GEO.viewRows, 7)).toBe(7);
  });

  test("heading rows are where heading units start", () => {
    const l = layoutOf([{ key: "h", height: 40, kind: "heading" }, { key: "p", height: 40 }, { key: "h2", height: 40, kind: "heading" }]);
    expect(headingRows(l)).toEqual([l.units[0]!.rowStart, l.units[2]!.rowStart]);
  });
});

describe("prefetchOrder", () => {
  test("visible slices first, then the nearest, leaning the way the view moves", () => {
    const l = layoutOf(Array.from({ length: 60 }, (_, i) => ({ key: `p${i}`, height: 60 })));
    const top = l.units[30]!.rowStart;
    const visible = new Set(visiblePlacements(l, top, GEO.viewRows).map((p) => p.imageKey));
    const bottom = top + GEO.viewRows;
    const distance = (s: { rowStart: number; rowEnd: number }) =>
      s.rowEnd <= top ? top - s.rowEnd + 1 : s.rowStart >= bottom ? s.rowStart - bottom + 1 : 0;
    for (const direction of [1, -1] as const) {
      const order = prefetchOrder(l, top, GEO.viewRows, direction);
      expect(new Set(order.slice(0, visible.size).map((s) => s.imageKey))).toEqual(visible);
      for (let i = 1; i < order.length; i++) {
        const [a, b] = [order[i - 1]!, order[i]!];
        expect(distance(a)).toBeLessThanOrEqual(distance(b));
        if (distance(a) === distance(b) && distance(a) > 0 && (a.rowStart >= bottom) !== (b.rowStart >= bottom)) {
          expect(a.rowStart >= bottom).toBe(direction > 0);
        }
      }
    }
  });
});
