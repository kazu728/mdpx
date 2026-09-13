export interface GraphicsLimits {
  /** null when tiles reach the terminal directly, so no per-frame limit applies. */
  frameBytes: number | null;
  storageBytes: number;
}

// herdr dedupes uploads by content signature, so scrolling within one generation only re-places
// (`a=p`) and stays cheap. Since v0.9.0 each image goes in its own transaction with the rest
// carried over, so frameBytes bounds one image, not the visible tiles combined. Neither limit is
// configurable: frameBytes is HEADLESS_GRAPHICS_TRANSACTION_BUDGET (herdr `src/protocol/wire.rs`
// and `src/kitty_graphics.rs`), storageBytes is KITTY_IMAGE_STORAGE_LIMIT_BYTES
// (herdr `src/ghostty/mod.rs`).
const HERDR_RELAY: GraphicsLimits = {
  frameBytes: 32 * 1024 * 1024 - 2 * 1024 * 1024,
  storageBytes: 64 * 1024 * 1024,
};

/** The 320MB quota the kitty graphics protocol names. Both storage limits count decoded pixels, not PNG bytes. */
const DIRECT: GraphicsLimits = { frameBytes: null, storageBytes: 320_000_000 };

export function detectGraphicsLimits(env: NodeJS.ProcessEnv = process.env): GraphicsLimits {
  const v = env.HERDR_ENV;
  return v !== undefined && v !== "" && v !== "0" ? HERDR_RELAY : DIRECT;
}

const KITTY_CHUNK_BYTES = 3072;

export function imageTransferEstimatedSize(dataLenBytes: number): number {
  return (
    Math.ceil(dataLenBytes / 3) * 4 + Math.ceil(dataLenBytes / KITTY_CHUNK_BYTES) * 16 + 1024
  );
}

/** Number of decoded tiles that fit while leaving room for terminal bookkeeping. */
export function residentTileCapacity(tileBytes: number, limits: GraphicsLimits): number {
  return Math.floor((limits.storageBytes * 0.8) / Math.max(1, tileBytes));
}

/** Decoded-tile count with no bookkeeping margin. */
export function totalTileCapacity(tileBytes: number, limits: GraphicsLimits): number {
  return Math.floor(limits.storageBytes / Math.max(1, tileBytes));
}

/** Keep the working set below terminal eviction and never below the visible-tile floor. */
export function maxResidentTiles(
  tileBytes: number,
  limits: GraphicsLimits,
  minTiles: number,
): number {
  return Math.max(minTiles, residentTileCapacity(tileBytes, limits));
}

/** Tiles touching one screen in the worst case: scrolling can straddle one extra boundary. */
export function maxTilesInFrame(viewportHeightPx: number, tileHeightPx: number): number {
  return Math.max(1, Math.ceil(viewportHeightPx / Math.max(1, tileHeightPx)) + 1);
}

export function fitsGraphicsFrame(
  limits: GraphicsLimits,
  imageWidthPx: number,
  tileHeightPx: number,
): boolean {
  return (
    limits.frameBytes === null ||
    imageTransferEstimatedSize(imageWidthPx * tileHeightPx * 4) <= limits.frameBytes
  );
}
