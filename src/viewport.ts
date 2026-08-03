// Pure viewport and scroll math (§4.5). No I/O.
//
// The coordinate system is "physical px offset from the top of the document"; scrollPx is always a
// multiple of the cell height. Tile heights are integer multiples of the cell height (§4.3), so the
// overlap between the viewport and a tile is always cell-aligned except at the end of the document —
// computeTiles pads the tail to a cell multiple to guarantee alignment there too (the padding is
// filled with the page background colour, so it looks unremarkable in the screenshot).

/**
 * Nominal brand that puts screen-px invariants into the type system.
 *
 * **Only the private helpers in this module mint them.** Every calculation that establishes an
 * invariant (alignment, snapping, rounding up) lives here, so as long as no door is left open for
 * outside code to lift a bare number into a brand, "it has the type" implies "it went through that
 * calculation". A branded number is assignable to a plain number one way, so consumers taking
 * `number` need no change.
 *
 * The brand does not carry **which cellHpx it was aligned to** (that would need a phantom type
 * parameter, and with cellHpx being a runtime value the cost does not pay off). Passing the right
 * cellHpx to the right place is not something the types protect.
 */
declare const brand: unique symbol;
type Brand<Tag extends string> = { readonly [brand]: Tag };

/** Screen px that is a multiple of the tile boundary unit `tileAlign` (= cellHpx × CSS_SCALE). */
export type TilePx = number & Brand<"TilePx">;

/** Document height covered by the tiles (bottom of the captured range, tile padding included). */
export type CoveredHeight = number & Brand<"CoveredHeight">;

const tilePx = (n: number): TilePx => n as TilePx;
const covered = (n: number): CoveredHeight => n as CoveredHeight;

/**
 * Tile cap per generation (§4.4); anything beyond it is not captured.
 * Now that a tile is one screenful tall (§4.3) the count roughly means "how many screens are
 * reachable", and a generation's capture count tops out at 128 too. Geometries where one screen
 * exceeds MAX_TILE_PX get tiles shorter than a screen, so their reach is smaller (about 85 screens
 * at rows=200, cellHpx=31). It always stays below ID_STRIDE, which is what guarantees imageId never
 * collides with the next generation for any geometry.
 */
const MAX_TILES = 128;

/** Rows in the content area (the last row is the status bar — §4.5). Never negative. */
export function contentRows(rows: number): number {
  return Math.max(0, rows - 1);
}

/**
 * CSS layout ratio (§4.3). `cssWidth = screenWidthPx / CSS_SCALE` fixes the font size and reflow.
 * Aligning tile boundaries to this multiple in physical px keeps the CSS-px clip an integer and
 * avoids CDP's rounding. **This is not the screenshot's deviceScaleFactor** (which diverges when
 * §4.8 downscales).
 */
export const CSS_SCALE = 2;

/**
 * Screen px → image px (§4.8). The identity at 1:1 (renderScale = CSS_SCALE).
 *
 * Callers align boundaries to scrollUnitPx / tileAlign, so srcY and the srcH of every intermediate
 * placement always map to integers. Rounding only touches **the height of the placement at the
 * bottom of the viewport**, which leaves half a px over when contentRows and the cell height are
 * both odd. There is no placement below it, so it never shows as a seam, but **that placement's
 * vertical magnification drifts from 2** (the error is inversely proportional to srcH, up to about
 * 3% when the bottom row is a single line). Making this exact would mean rounding the visible row
 * count down to the unit, which permanently wastes the bottom row, so the rounding is accepted.
 */
export function toImagePx(screenPx: number, renderScale: number): number {
  return Math.round((screenPx * renderScale) / CSS_SCALE);
}

/**
 * Unit for scroll and placement boundaries (physical px, §4.8): the smallest cell multiple that
 * maps to an integer number of image px. One cell at 1:1. When downscaling with an odd cell height
 * a single cell leaves half a px over, so it falls back to two cells (tileAlign maps to an integer
 * regardless of renderScale, making it an always-safe fallback).
 */
export function scrollUnitPx(cellHpx: number, renderScale: number): number {
  return (cellHpx * renderScale) % CSS_SCALE === 0 ? cellHpx : tileAlign(cellHpx);
}

/**
 * Tile boundary alignment unit (physical px): the smallest unit that is both a multiple of the cell
 * height (so placement rows are integers) and of the dsf (so the screenshot clip is integer CSS px).
 */
function tileAlign(cellHpx: number): number {
  return cellHpx * CSS_SCALE;
}

/**
 * Sanity cap on tile height (physical px). Both rows and cellHpx come from the terminal and the
 * environment; cellHpx is bounded by MAX_CELL_PX but rows is not. This keeps a pathological
 * combination from requesting an enormous screenshot (it is not a kitty-side constraint).
 */
const MAX_TILE_PX = 4096;

/**
 * Tile height (§4.3): the smallest tileAlign multiple that covers one screenful
 * (contentRows × cellHpx). Rounding up is what makes the viewport fit inside exactly one tile at
 * scrollPx=0, so nothing more than what is shown gets captured first.
 */
export function tileHeightPx(cellHpx: number, contentRows: number): TilePx {
  const unit = tileAlign(cellHpx);
  const capped = Math.floor(MAX_TILE_PX / unit) * unit;
  const screenful = Math.ceil((Math.max(0, contentRows) * cellHpx) / unit) * unit;
  // contentRows=0 (rows=1) makes screenful=0. computeTiles bails out before that, but §4.8's
  // resolution check divides by the tile height and would break on 0, so return at least one unit
  return tilePx(Math.max(unit, Math.min(screenful, capped)));
}

export interface Tile {
  /** Offset of the tile's top within the document. */
  y: TilePx;
  /** Tile height. */
  height: TilePx;
}

export interface TileLayout {
  tiles: Tile[];
  /** True when MAX_TILES cut the document short (drives §4.4's "truncated" indicator). */
  truncated: boolean;
  /**
   * Effective document height used for the scroll limit (a multiple of the cell height). Tiles are
   * padded out to a 2*cellHpx boundary, but that trailing padding (background colour) is not
   * somewhere to scroll to, so this is the real document height rounded to a cell multiple rather
   * than coveredHeight. When truncated it caps at the bottom of what was captured (coveredHeight).
   */
  contentHpx: number;
}

/**
 * Pad the full document height to a cell multiple and split it into tiles.
 * The tail becomes a cell multiple too, so every interval the visibility math touches is cell-aligned.
 */
export function computeTiles(docHpx: number, cellHpx: number, contentRows: number): TileLayout {
  // With no content area (rows=1, all status bar) there is nowhere to place a tile, and a capture
  // would never be displayed, so take none
  if (contentRows <= 0) return { tiles: [], truncated: false, contentHpx: 0 };
  const th = tileHeightPx(cellHpx, contentRows);
  const unit = tileAlign(cellHpx);
  const paddedH = Math.ceil(Math.max(0, docHpx) / unit) * unit;
  const tiles: Tile[] = [];
  let y = 0;
  while (y < paddedH && tiles.length < MAX_TILES) {
    // paddedH and th are both multiples of unit, so y / height stay unit-aligned including the tail
    const height = Math.min(th, paddedH - y);
    tiles.push({ y: tilePx(y), height: tilePx(height) });
    y += height;
  }
  const cellPadded = Math.ceil(Math.max(0, docHpx) / cellHpx) * cellHpx;
  return { tiles, truncated: y < paddedH, contentHpx: Math.min(cellPadded, coveredHeight(tiles)) };
}

export function coveredHeight(tiles: Tile[]): CoveredHeight {
  const last = tiles[tiles.length - 1];
  return covered(last ? last.y + last.height : 0);
}

/**
 * Maximum scrollPx for a content area of rows-1 lines. contentHpx is computeTiles' effective document height.
 * It **rounds up** to the scroll unit — rounding down would put the last unit of real content out of
 * reach. Whatever the rounding adds lands on the document's trailing tile padding (background
 * colour) or gets trimmed by the visibility math. At 1:1 both contentHpx and contentRows*cellHpx are
 * cell multiples, so the rounding is a no-op.
 */
export function maxScrollPx(
  contentHpx: number,
  contentRows: number,
  cellHpx: number,
  renderScale: number,
): number {
  const unit = scrollUnitPx(cellHpx, renderScale);
  const raw = Math.ceil(Math.max(0, contentHpx - contentRows * cellHpx) / unit) * unit;
  // If the rounding pushed past the end of the document, the viewport would overlap no tile at all
  // and not a single body image would be placed (leaving only a status bar reading 100%). Cap at the
  // largest unit multiple whose top is still inside the document
  const inside = Math.max(0, Math.ceil(contentHpx / unit) * unit - unit);
  return Math.min(raw, inside);
}

/** Snap scrollPx to the scroll unit and clamp it to [0, maxScrollPx] (§4.5; also used to carry the position across generations). */
export function clampScroll(
  scrollPx: number,
  contentHpx: number,
  contentRows: number,
  cellHpx: number,
  renderScale: number,
): number {
  const unit = scrollUnitPx(cellHpx, renderScale);
  const snapped = Math.round(scrollPx / unit) * unit;
  return Math.max(0, Math.min(snapped, maxScrollPx(contentHpx, contentRows, cellHpx, renderScale)));
}

// srcY / srcH are **screen px**. Turning them into kitty's source rect (image px) goes through
// toImagePx (§4.8).
export interface Placement {
  tileIndex: number;
  /** Top offset within the tile (screen px). */
  srcY: number;
  /** Height of the slice (screen px, a multiple of the cell height). */
  srcH: number;
  /** Row of the content area to place it on (0-based). */
  row: number;
  /** Rows occupied (= srcH / cellHpx). */
  rows: number;
}

/**
 * Find the tiles visible at the current scroll position and their source rects (pure).
 * The overlap between the viewport and a tile is a single interval, so each tile yields at most one
 * placement. Across a tile boundary the two adjacent tiles each yield one, placed back to back.
 */
export function visibleTiles(scrollPx: number, contentRows: number, cellHpx: number, tiles: Tile[]): Placement[] {
  const viewTop = scrollPx;
  const viewBottom = scrollPx + contentRows * cellHpx;
  const placements: Placement[] = [];
  for (let i = 0; i < tiles.length; i++) {
    const tile = tiles[i]!;
    const overlapTop = Math.max(viewTop, tile.y);
    const overlapBottom = Math.min(viewBottom, tile.y + tile.height);
    if (overlapBottom <= overlapTop) continue;
    placements.push({
      tileIndex: i,
      srcY: overlapTop - tile.y,
      srcH: overlapBottom - overlapTop,
      row: (overlapTop - viewTop) / cellHpx,
      rows: (overlapBottom - overlapTop) / cellHpx,
    });
  }
  return placements;
}

/**
 * Capture order by proximity to the viewport (for §4.1's backfill): visible tiles, then nearby, then
 * far. The scheduler uses it to pick "the next one".
 */
export function backfillOrder(scrollPx: number, contentRows: number, cellHpx: number, tiles: Tile[]): number[] {
  const center = scrollPx + (contentRows * cellHpx) / 2;
  return tiles
    .map((t, index) => ({ index, dist: Math.abs(t.y + t.height / 2 - center) }))
    .sort((a, b) => a.dist - b.dist || a.index - b.index)
    .map((t) => t.index);
}
