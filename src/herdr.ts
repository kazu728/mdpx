// herdr relays full tile transfers (`a=t`), not clipped placements, and drops frames over 32 MiB.
// The limit therefore depends on tile geometry.

// This limit comes from herdr's `src/protocol/wire.rs` and cannot be configured.
const GRAPHICS_FRAME_LIMIT = 32 * 1024 * 1024;

function relayBytes(imageWidthPx: number, tileHeightPx: number): number {
  return imageWidthPx * tileHeightPx * 4 * (4 / 3);
}

/** Herdr allows 64 MiB and Ghostty 320 MB; both count decoded pixels, not PNG bytes. */
const IMAGE_STORAGE_LIMIT = { herdr: 64 * 1024 * 1024, ghostty: 320_000_000 };

/** Keep the working set below terminal eviction and never below the visible-tile floor. */
export function maxResidentTiles(tileBytes: number, relayed: boolean, minTiles: number): number {
  const limit = relayed ? IMAGE_STORAGE_LIMIT.herdr : IMAGE_STORAGE_LIMIT.ghostty;
  // The terminal also spends storage on placements and other bookkeeping, so do not claim the full limit
  const budget = Math.floor((limit * 0.8) / Math.max(1, tileBytes));
  return Math.max(minTiles, budget);
}

export function visibleTileCount(viewportHeightPx: number, tileHeightPx: number): number {
  return maxTilesInFrame(viewportHeightPx, tileHeightPx);
}

export function inHerdrPane(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.HERDR_ENV;
  return v !== undefined && v !== "" && v !== "0";
}

/** Count unsent tiles needed to cover one screen; captures are transferred sequentially. */
function maxTilesInFrame(viewportHeightPx: number, tileHeightPx: number): number {
  return Math.max(1, Math.ceil(Math.max(0, viewportHeightPx) / tileHeightPx));
}

export function fitsGraphicsFrame(
  imageWidthPx: number,
  tileHeightPx: number,
  tilesInFrame: number,
): boolean {
  return tilesInFrame * relayBytes(imageWidthPx, tileHeightPx) <= GRAPHICS_FRAME_LIMIT;
}

export interface RelayGeometry {
  viewportWidthCssPx: number;
  tileHeightPx: number;
  viewportHeightPx: number;
  /** Scroll unit after downscaling; disable downscaling if a viewport cannot reach the document end. */
  reducedScrollUnitPx: number;
  fullScale: number;
  relayed: boolean;
}

export function pickRenderScale(g: RelayGeometry): { renderScale: number; relayOverflow: boolean } {
  const tiles = maxTilesInFrame(g.viewportHeightPx, g.tileHeightPx);
  const fitsAt = (scale: number) =>
    fitsGraphicsFrame(
      g.viewportWidthCssPx * scale,
      (g.tileHeightPx * scale) / g.fullScale,
      tiles,
    );

  const canReduce = g.relayed && g.viewportHeightPx >= g.reducedScrollUnitPx;
  const renderScale = !g.relayed || fitsAt(g.fullScale) || !canReduce ? g.fullScale : 1;
  return { renderScale, relayOverflow: g.relayed && !fitsAt(renderScale) };
}
