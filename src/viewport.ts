// Tile heights are integer multiples of the cell height, so the overlap between the viewport
// and a tile is always cell-aligned except at the end of the document — computeTiles pads the tail
// to a cell multiple to guarantee alignment there too (the padding is filled with the page
// background colour, so it looks unremarkable in the screenshot).

/**
 * Only this module mints aligned-pixel brands. They deliberately do not encode which runtime
 * cellHpx established the alignment; doing so would require a phantom type that adds more
 * conversion overhead than protection.
 */
declare const brand: unique symbol;
type Brand<Tags extends string> = { readonly [brand]: Record<Tags, true> };

export type TileAlignedPx = number & Brand<"tileAligned">;

export type CellAlignedPx = number & Brand<"cellAligned">;

export type ScrollAlignedPx = number & Brand<"cellAligned" | "scrollUnitAligned">;

export const SCROLL_TOP = 0 as ScrollAlignedPx;

/**
 * Tiles are padded out to a `tileAlign` boundary, but that trailing padding (page background) is
 * not scrollable. Keeping its height distinct from `coveredHeightPx()` prevents scrolling into the
 * padding or promoting a generation with no visible tile.
 */
export type ContentHeightPx = number & Brand<"contentHeight">;

export const NO_CONTENT_HEIGHT = 0 as ContentHeightPx;

const asTileAlignedPx = (n: number): TileAlignedPx => n as TileAlignedPx;
const asContentHeightPx = (n: number): ContentHeightPx => n as ContentHeightPx;
const asCellAlignedPx = (n: number): CellAlignedPx => n as CellAlignedPx;
const asScrollAlignedPx = (n: number): ScrollAlignedPx => n as ScrollAlignedPx;

/**
 * This bounds capture cost and stays below IMAGE_ID_GENERATION_STRIDE so adjacent generations
 * cannot collide. It does not guarantee 128 reachable screens when MAX_TILE_PX shortens each tile.
 */
const MAX_TILES = 128;

export function contentRows(rows: number): number {
  return Math.max(0, rows - 1);
}

/**
 * CSS layout ratio. `viewportWidthCssPx = screenWidthPx / CSS_SCALE` fixes the font size and reflow.
 * Aligning tile boundaries to this multiple in physical px keeps the CSS-px clip an integer and
 * avoids CDP's rounding. **This is not the screenshot's deviceScaleFactor** (which diverges when
 * the render scale downscales).
 */
export const CSS_SCALE = 2;

export const REDUCED_SCALE = 1;

/** Rounding only affects the bottom placement, where a half-pixel overhang cannot form a seam. */
export function toImagePx(screenPx: number, renderScale: number): number {
  return Math.round((screenPx * renderScale) / CSS_SCALE);
}

/** Odd-height downscaled cells require a two-cell scroll unit. */
export function scrollUnitPx(cellHpx: number, renderScale: number): number {
  return (cellHpx * renderScale) % CSS_SCALE === 0 ? cellHpx : tileAlign(cellHpx);
}

function tileAlign(cellHpx: number): number {
  return cellHpx * CSS_SCALE;
}

/**
 * Terminal rows are unbounded, so cap screenshot requests independently of kitty's limits.
 */
const MAX_TILE_PX = 4096;

export function maximumTileHeightPx(cellHpx: number): TileAlignedPx {
  const unit = tileAlign(cellHpx);
  return asTileAlignedPx(Math.max(unit, Math.floor(MAX_TILE_PX / unit) * unit));
}

export function alignedTileHeightPx(cellHpx: number, rows: number): TileAlignedPx {
  const unit = tileAlign(cellHpx);
  const capped = maximumTileHeightPx(cellHpx);
  const requested = Math.ceil((rows * cellHpx) / unit) * unit;
  return asTileAlignedPx(Math.max(unit, Math.min(requested, capped)));
}

export interface Tile {
  topPx: TileAlignedPx;
  heightPx: TileAlignedPx;
}

export interface TileLayout {
  tiles: Tile[];
  truncated: boolean;
  contentHeightPx: ContentHeightPx;
}

export function computeTiles(
  documentHeightPx: number,
  cellHpx: number,
  contentRows: number,
  tileHeightPx: TileAlignedPx,
): TileLayout {
  if (contentRows <= 0) {
    return { tiles: [], truncated: false, contentHeightPx: NO_CONTENT_HEIGHT };
  }
  const unit = tileAlign(cellHpx);
  const clampedDocumentHeightPx = Math.max(0, documentHeightPx);
  const paddedH = Math.ceil(clampedDocumentHeightPx / unit) * unit;
  const tiles: Tile[] = [];
  let y = 0;
  while (y < paddedH && tiles.length < MAX_TILES) {
    const height = Math.min(tileHeightPx, paddedH - y);
    tiles.push({ topPx: asTileAlignedPx(y), heightPx: asTileAlignedPx(height) });
    y += height;
  }
  const cellPadded = Math.ceil(clampedDocumentHeightPx / cellHpx) * cellHpx;
  return {
    tiles,
    truncated: y < paddedH,
    contentHeightPx: asContentHeightPx(Math.min(cellPadded, coveredHeightPx(tiles))),
  };
}

export function coveredHeightPx(tiles: Tile[]): number {
  const last = tiles[tiles.length - 1];
  return last ? last.topPx + last.heightPx : 0;
}

/** Round up to a scroll unit so the document tail remains reachable. */
export function maxScrollPx(
  contentHeightPx: ContentHeightPx,
  contentRows: number,
  cellHpx: number,
  renderScale: number,
): ScrollAlignedPx {
  const unit = scrollUnitPx(cellHpx, renderScale);
  const raw = Math.ceil(Math.max(0, contentHeightPx - contentRows * cellHpx) / unit) * unit;
  // Keep the viewport over the document so at least one body image is placed.
  const inside = Math.max(0, Math.ceil(contentHeightPx / unit) * unit - unit);
  return asScrollAlignedPx(Math.min(raw, inside));
}

export function clampScroll(
  scrollPx: number,
  contentHeightPx: ContentHeightPx,
  contentRows: number,
  cellHpx: number,
  renderScale: number,
): ScrollAlignedPx {
  const unit = scrollUnitPx(cellHpx, renderScale);
  const snapped = Math.round(scrollPx / unit) * unit;
  return asScrollAlignedPx(
    Math.max(
      0,
      Math.min(snapped, maxScrollPx(contentHeightPx, contentRows, cellHpx, renderScale)),
    ),
  );
}

export interface Placement {
  tileIndex: number;
  sourceTopPx: CellAlignedPx;
  sourceHeightPx: CellAlignedPx;
  destinationRow: number;
  destinationRows: number;
}

export function visibleTiles(
  scrollPx: ScrollAlignedPx,
  contentRows: number,
  cellHpx: number,
  tiles: Tile[],
): Placement[] {
  const viewTop = scrollPx;
  const viewBottom = scrollPx + contentRows * cellHpx;
  const placements: Placement[] = [];
  for (let i = 0; i < tiles.length; i++) {
    const tile = tiles[i]!;
    const overlapTop = Math.max(viewTop, tile.topPx);
    const overlapBottom = Math.min(viewBottom, tile.topPx + tile.heightPx);
    if (overlapBottom <= overlapTop) continue;
    placements.push({
      tileIndex: i,
      sourceTopPx: asCellAlignedPx(overlapTop - tile.topPx),
      sourceHeightPx: asCellAlignedPx(overlapBottom - overlapTop),
      destinationRow: (overlapTop - viewTop) / cellHpx,
      destinationRows: (overlapBottom - overlapTop) / cellHpx,
    });
  }
  return placements;
}

export function backfillOrder(
  scrollPx: ScrollAlignedPx,
  contentRows: number,
  cellHpx: number,
  tiles: Tile[],
): number[] {
  const center = scrollPx + (contentRows * cellHpx) / 2;
  return tiles
    .map((tile, index) => ({
      index,
      dist: Math.abs(tile.topPx + tile.heightPx / 2 - center),
    }))
    .sort((a, b) => a.dist - b.dist || a.index - b.index)
    .map((t) => t.index);
}
