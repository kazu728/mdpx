export type ScrollDirection = -1 | 0 | 1;

/** Bounds capture cost and stays below IMAGE_ID_GENERATION_STRIDE. */
const MAX_TILES = 128;

export function contentRows(rows: number): number {
  return Math.max(0, rows - 1);
}

/** CSS layout ratio; not the screenshot deviceScaleFactor. */
export const CSS_SCALE = 2;

export const REDUCED_SCALE = 1;

export function toImagePx(screenPx: number, renderScale: number): number {
  return Math.round((screenPx * renderScale) / CSS_SCALE);
}

/** Odd-height downscaled cells need a two-cell scroll unit. */
export function scrollUnitPx(cellHpx: number, renderScale: number): number {
  return (cellHpx * renderScale) % CSS_SCALE === 0 ? cellHpx : cellHpx * CSS_SCALE;
}

function tileAlign(cellHpx: number): number {
  return cellHpx * CSS_SCALE;
}

// Terminal rows are unbounded, so cap screenshot requests independently of kitty limits.
const MAX_TILE_PX = 4096;

export function maximumTileHeightPx(cellHpx: number): number {
  const unit = tileAlign(cellHpx);
  return Math.floor(MAX_TILE_PX / unit) * unit;
}

export function alignedTileHeightPx(cellHpx: number, rows: number): number {
  const unit = tileAlign(cellHpx);
  const capped = maximumTileHeightPx(cellHpx);
  const requested = Math.ceil((rows * cellHpx) / unit) * unit;
  return Math.max(unit, Math.min(requested, capped));
}

export interface Tile {
  topPx: number;
  heightPx: number;
}

interface TileLayout {
  tiles: Tile[];
  truncated: boolean;
  contentHeightPx: number;
}

export function computeTiles(
  documentHeightPx: number,
  cellHpx: number,
  contentRows: number,
  tileHeightPx: number,
): TileLayout {
  if (contentRows <= 0) {
    return { tiles: [], truncated: false, contentHeightPx: 0 };
  }
  const unit = tileAlign(cellHpx);
  const clampedDocumentHeightPx = Math.max(0, documentHeightPx);
  const paddedH = Math.ceil(clampedDocumentHeightPx / unit) * unit;
  const tiles: Tile[] = [];
  let y = 0;
  while (y < paddedH && tiles.length < MAX_TILES) {
    const height = Math.min(tileHeightPx, paddedH - y);
    tiles.push({ topPx: y, heightPx: height });
    y += height;
  }
  const cellPadded = Math.ceil(clampedDocumentHeightPx / cellHpx) * cellHpx;
  return {
    tiles,
    truncated: y < paddedH,
    contentHeightPx: Math.min(cellPadded, coveredHeightPx(tiles)),
  };
}

export function coveredHeightPx(tiles: Tile[]): number {
  const last = tiles[tiles.length - 1];
  return last ? last.topPx + last.heightPx : 0;
}

export function maxScrollPx(
  contentHeightPx: number,
  contentRows: number,
  cellHpx: number,
  renderScale: number,
): number {
  const unit = scrollUnitPx(cellHpx, renderScale);
  const raw = Math.ceil(Math.max(0, contentHeightPx - contentRows * cellHpx) / unit) * unit;
  // Keep at least one body image placed over the document.
  const inside = Math.max(0, Math.ceil(contentHeightPx / unit) * unit - unit);
  return Math.min(raw, inside);
}

export function clampScroll(
  scrollPx: number,
  contentHeightPx: number,
  contentRows: number,
  cellHpx: number,
  renderScale: number,
): number {
  const unit = scrollUnitPx(cellHpx, renderScale);
  const snapped = Math.round(scrollPx / unit) * unit;
  return Math.max(
    0,
    Math.min(snapped, maxScrollPx(contentHeightPx, contentRows, cellHpx, renderScale)),
  );
}

interface Placement {
  tileIndex: number;
  sourceTopPx: number;
  sourceHeightPx: number;
  destinationRow: number;
  destinationRows: number;
}

export function visibleTiles(
  scrollPx: number,
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
      sourceTopPx: overlapTop - tile.topPx,
      sourceHeightPx: overlapBottom - overlapTop,
      destinationRow: (overlapTop - viewTop) / cellHpx,
      destinationRows: (overlapBottom - overlapTop) / cellHpx,
    });
  }
  return placements;
}

export function backfillOrder(
  scrollPx: number,
  contentRows: number,
  cellHpx: number,
  tiles: Tile[],
  direction: ScrollDirection = 0,
): number[] {
  const center = scrollPx + (contentRows * cellHpx) / 2;
  return tiles
    .map((tile, index) => ({
      index,
      dist: Math.abs(tile.topPx + tile.heightPx / 2 - center),
    }))
    .sort((a, b) => a.dist - b.dist || direction * (b.index - a.index) || a.index - b.index)
    .map((t) => t.index);
}
