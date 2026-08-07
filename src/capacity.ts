export interface GraphicsLimits {
  /** null when tiles reach the terminal directly, so no per-frame limit applies. */
  frameBytes: number | null;
  storageBytes: number;
}

// herdr dedupes uploads by content signature, so scrolling within one generation only re-places
// (`a=p`) and stays cheap. A new generation gives every tile a fresh image ID, so its first frame
// carries every visible tile's bytes — that worst case is what these budgets bound. Neither limit
// is configurable: frameBytes is MAX_GRAPHICS_FRAME_SIZE (herdr `src/protocol/wire.rs`),
// storageBytes is KITTY_IMAGE_STORAGE_LIMIT_BYTES (herdr `src/ghostty/mod.rs`).
const HERDR_RELAY: GraphicsLimits = {
  frameBytes: 32 * 1024 * 1024,
  storageBytes: 64 * 1024 * 1024,
};

/** The 320MB quota the kitty graphics protocol names. Both storage limits count decoded pixels, not PNG bytes. */
const DIRECT: GraphicsLimits = { frameBytes: null, storageBytes: 320_000_000 };

export function detectGraphicsLimits(env: NodeJS.ProcessEnv = process.env): GraphicsLimits {
  const v = env.HERDR_ENV;
  return v !== undefined && v !== "" && v !== "0" ? HERDR_RELAY : DIRECT;
}

function relayBytes(imageWidthPx: number, tileHeightPx: number): number {
  return imageWidthPx * tileHeightPx * 4 * (4 / 3);
}

/** Number of decoded tiles that fit while leaving room for terminal bookkeeping. */
export function residentTileCapacity(tileBytes: number, limits: GraphicsLimits): number {
  return Math.floor((limits.storageBytes * 0.8) / Math.max(1, tileBytes));
}

/** Keep the working set below terminal eviction and never below the visible-tile floor. */
export function maxResidentTiles(
  tileBytes: number,
  limits: GraphicsLimits,
  minTiles: number,
): number {
  return Math.max(minTiles, residentTileCapacity(tileBytes, limits));
}

/** Count unsent tiles needed to cover one screen; captures are transferred sequentially. */
export function maxTilesInFrame(viewportHeightPx: number, tileHeightPx: number): number {
  return Math.max(1, Math.ceil(viewportHeightPx / tileHeightPx));
}

export function fitsGraphicsFrame(
  limits: GraphicsLimits,
  imageWidthPx: number,
  tileHeightPx: number,
  tilesInFrame: number,
): boolean {
  return (
    limits.frameBytes === null ||
    tilesInFrame * relayBytes(imageWidthPx, tileHeightPx) <= limits.frameBytes
  );
}
