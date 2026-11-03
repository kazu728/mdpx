import { createHash } from "node:crypto";
import { CELL_CSS_PX, maxSliceImagePx, type Geometry, type RasterSpec } from "./geometry.ts";
import type { BlockKind } from "./markdown.ts";
import type { Theme } from "./theme.ts";

export interface PlacedBlock {
  readonly key: string;
  readonly kind: BlockKind;
  readonly topCss: number;
  readonly heightCss: number;
}

export interface SyncedLayout {
  readonly raster: RasterSpec;
  readonly theme: Theme;
  readonly blocks: readonly PlacedBlock[];
  readonly docHeightCss: number;
}

/** The nth block with this key, in document order. */
export interface BlockRef {
  readonly key: string;
  readonly occurrence: number;
}

/** What to screenshot: part of the run of blocks from first to last, in CSS px from its top. */
export interface CaptureRef {
  readonly first: BlockRef;
  readonly last: BlockRef;
  /** The run's height when laid out. The page refuses a capture once the run has another height. */
  readonly runHeightImgPx: number;
  readonly offsetCss: number;
  readonly lengthCss: number;
}

export interface CapturedImage {
  readonly contentTopImgPx: number;
  readonly heightImgPx: number;
}

export interface Slice {
  readonly imageKey: string;
  readonly rowStart: number;
  readonly rowEnd: number;
  readonly contentTopScreenPx: number;
  readonly capture: CaptureRef;
  /** The most the image can take in the terminal. */
  readonly maxBytes: number;
}

/**
 * A run of blocks with at least one row of blank page above and below it. A row on screen
 * that shows the unit never reaches past that blank page, so its slices show the same pixels
 * whichever row phase the unit lands on, and units never share a terminal row.
 */
export interface Unit {
  readonly members: readonly BlockRef[];
  readonly heading: boolean;
  readonly topScreenPx: number;
  readonly rowStart: number;
  readonly rowEnd: number;
  readonly slices: readonly Slice[];
}

export interface Layout {
  readonly raster: RasterSpec;
  readonly theme: Theme;
  readonly units: readonly Unit[];
  readonly blockKeys: readonly string[];
  readonly totalRows: number;
  readonly slices: ReadonlyMap<string, Slice>;
}

export interface Placement {
  readonly imageKey: string;
  readonly unit: number;
  readonly screenRow: number;
  readonly rows: number;
  /** Image px from the slice's first content row to the first row shown; negative above it. */
  readonly offsetImgPx: number;
  readonly sourceHImgPx: number;
}

/**
 * The crop of a captured image that fills a placement. The image holds at least one row of
 * page around its content, so the crop stays inside it whatever row phase the content has now.
 */
export function cropOf(p: Placement, image: CapturedImage): { y: number; h: number } {
  const h = Math.min(p.sourceHImgPx, image.heightImgPx);
  const y = Math.round(image.contentTopImgPx + p.offsetImgPx);
  return { y: Math.max(0, Math.min(y, image.heightImgPx - h)), h };
}

export interface Anchor {
  readonly block: BlockRef;
  /** Rows from the anchored unit's first row to the top of the view; negative inside the gap above it. */
  readonly offset: number;
}

export type ScrollDirection = -1 | 0 | 1;

function digest(parts: readonly string[]): string {
  return createHash("sha1").update(parts.join("\n")).digest("base64url").slice(0, 22);
}

function groupBlocks(blocks: readonly PlacedBlock[]): number[][] {
  const groups: number[][] = [];
  let bottom = -Infinity;
  blocks.forEach((b, i) => {
    if (b.heightCss <= 0) return;
    const last = groups.at(-1);
    const blockBottom = b.topCss + b.heightCss;
    if (last && b.topCss - bottom < CELL_CSS_PX) {
      last.push(i);
      bottom = Math.max(bottom, blockBottom);
    } else {
      groups.push([i]);
      bottom = blockBottom;
    }
  });
  return groups;
}

export function buildLayout(synced: SyncedLayout, g: Geometry): Layout {
  const { cellHpx, renderScale } = g.raster;
  const toScreenPx = (css: number) => (css * cellHpx) / CELL_CSS_PX;
  const seen = new Map<string, number>();
  const refs: BlockRef[] = synced.blocks.map((b) => {
    const occurrence = seen.get(b.key) ?? 0;
    seen.set(b.key, occurrence + 1);
    return { key: b.key, occurrence };
  });

  const slices = new Map<string, Slice>();
  const units = groupBlocks(synced.blocks).map((indices): Unit => {
    const members = indices.map((i) => refs[i]!);
    const blocks = indices.map((i) => synced.blocks[i]!);
    const topCss = Math.min(...blocks.map((b) => b.topCss));
    const bottomCss = Math.max(...blocks.map((b) => b.topCss + b.heightCss));
    const key = members.length === 1 ? members[0]!.key : digest(members.map((m) => m.key));
    const topScreenPx = toScreenPx(topCss);
    const heightImgPx = Math.round((bottomCss - topCss) * g.deviceScaleFactor);
    const rowStart = Math.floor(topScreenPx / cellHpx);
    const rowEnd = Math.max(rowStart + 1, Math.ceil(toScreenPx(bottomCss) / cellHpx));
    const count = Math.max(1, Math.ceil((bottomCss - topCss) / (g.raster.sliceRows * CELL_CSS_PX)));
    const starts = Array.from({ length: count }, (_, k) =>
      k === 0 ? rowStart : Math.floor(toScreenPx(topCss + k * g.raster.sliceRows * CELL_CSS_PX) / cellHpx),
    );
    const sliceCss = g.raster.sliceRows * CELL_CSS_PX;
    const unitSlices = starts.map((start, k): Slice => {
      const offsetCss = k * sliceCss;
      const lengthCss = Math.min(sliceCss, bottomCss - topCss - offsetCss);
      const slice: Slice = {
        imageKey: `${key}/${k}/${heightImgPx}`,
        rowStart: start,
        rowEnd: starts[k + 1] ?? rowEnd,
        contentTopScreenPx: toScreenPx(topCss + offsetCss),
        capture: { first: members[0]!, last: members.at(-1)!, runHeightImgPx: heightImgPx, offsetCss, lengthCss },
        maxBytes: g.imgWidthPx * maxSliceImagePx(lengthCss, g.raster) * 4,
      };
      slices.set(slice.imageKey, slice);
      return slice;
    });
    return {
      members,
      heading: blocks[0]!.kind === "heading",
      topScreenPx,
      rowStart,
      rowEnd,
      slices: unitSlices,
    };
  });

  return {
    raster: synced.raster,
    theme: synced.theme,
    units,
    blockKeys: synced.blocks.map((b) => b.key),
    totalRows: Math.ceil(toScreenPx(synced.docHeightCss) / cellHpx),
    slices,
  };
}

export function visiblePlacements(layout: Layout, top: number, viewRows: number): Placement[] {
  const { cellHpx, renderScale } = layout.raster;
  const bottom = top + viewRows;
  const out: Placement[] = [];
  layout.units.forEach((unit, index) => {
    if (unit.rowEnd <= top || unit.rowStart >= bottom) return;
    for (const slice of unit.slices) {
      const r0 = Math.max(slice.rowStart, top);
      const r1 = Math.min(slice.rowEnd, bottom);
      if (r1 <= r0) continue;
      out.push({
        imageKey: slice.imageKey,
        unit: index,
        screenRow: r0 - top,
        rows: r1 - r0,
        offsetImgPx: (r0 * cellHpx - slice.contentTopScreenPx) * renderScale,
        sourceHImgPx: Math.round((r1 - r0) * cellHpx * renderScale),
      });
    }
  });
  return out;
}

export function visibleImageKeys(layout: Layout, top: number, viewRows: number): Set<string> {
  return new Set(visiblePlacements(layout, top, viewRows).map((p) => p.imageKey));
}

export function maxTop(layout: Layout, viewRows: number): number {
  return Math.max(0, layout.totalRows - viewRows);
}

export function clampTop(layout: Layout, top: number, viewRows: number): number {
  return Math.max(0, Math.min(Math.round(top), maxTop(layout, viewRows)));
}

export function anchorAt(layout: Layout, top: number): Anchor | null {
  const unit = layout.units.find((u) => u.rowEnd > top);
  return unit ? { block: unit.members[0]!, offset: top - unit.rowStart } : null;
}

/**
 * The top that keeps the anchored block where it was: the same (key, occurrence) if it is
 * still there, else the same key with the nearest occurrence, else `fallback`.
 */
export function topFor(layout: Layout, anchor: Anchor | null, viewRows: number, fallback: number): number {
  if (!anchor) return clampTop(layout, fallback, viewRows);
  const { key, occurrence } = anchor.block;
  let best: { unit: Unit; distance: number } | null = null;
  for (const unit of layout.units) {
    for (const m of unit.members) {
      if (m.key !== key) continue;
      const distance = Math.abs(m.occurrence - occurrence);
      if (!best || distance < best.distance) best = { unit, distance };
    }
  }
  return clampTop(layout, best ? best.unit.rowStart + anchor.offset : fallback, viewRows);
}

export function headingRows(layout: Layout): number[] {
  return layout.units.filter((u) => u.heading).map((u) => u.rowStart);
}

export function prefetchOrder(
  layout: Layout,
  top: number,
  viewRows: number,
  direction: ScrollDirection,
): Slice[] {
  const bottom = top + viewRows;
  const distance = (s: Slice) =>
    s.rowEnd <= top ? top - s.rowEnd + 1 : s.rowStart >= bottom ? s.rowStart - bottom + 1 : 0;
  const ranked = [...layout.slices.values()].map((s) => ({ s, d: distance(s), side: s.rowStart >= bottom ? 1 : s.rowEnd <= top ? -1 : 0 }));
  ranked.sort((a, b) => a.d - b.d || (a.side === direction ? -1 : 0) - (b.side === direction ? -1 : 0) || a.s.rowStart - b.s.rowStart);
  return ranked.map((r) => r.s);
}
