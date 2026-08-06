import { CSS_SCALE, REDUCED_SCALE } from "./viewport.ts";

export interface GraphicsLimits {
  /** null when tiles reach the terminal directly, so no per-frame limit applies. */
  frameBytes: number | null;
  storageBytes: number;
}

// herdr relays full tile transfers (`a=t`), not clipped placements, so a frame's cost depends on
// tile geometry. Its limits come from `src/protocol/wire.rs` and cannot be configured.
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

/** Keep the working set below terminal eviction and never below the visible-tile floor. */
export function maxResidentTiles(
  tileBytes: number,
  limits: GraphicsLimits,
  minTiles: number,
): number {
  // The terminal also spends storage on placements and other bookkeeping, so do not claim the full limit
  const budget = Math.floor((limits.storageBytes * 0.8) / Math.max(1, tileBytes));
  return Math.max(minTiles, budget);
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

interface RenderScaleInput {
  viewportWidthCssPx: number;
  tileHeightPx: number;
  viewportHeightPx: number;
  /** Scroll unit after downscaling; disable downscaling if a viewport cannot reach the document end. */
  reducedScrollUnitPx: number;
  limits: GraphicsLimits;
}

export function pickRenderScale(
  g: RenderScaleInput,
): { renderScale: number; exceedsFrameLimit: boolean } {
  const tiles = maxTilesInFrame(g.viewportHeightPx, g.tileHeightPx);
  const fitsAt = (scale: number) =>
    fitsGraphicsFrame(
      g.limits,
      g.viewportWidthCssPx * scale,
      (g.tileHeightPx * scale) / CSS_SCALE,
      tiles,
    );

  const canReduce = g.limits.frameBytes !== null && g.viewportHeightPx >= g.reducedScrollUnitPx;
  const renderScale = fitsAt(CSS_SCALE) || !canReduce ? CSS_SCALE : REDUCED_SCALE;
  return { renderScale, exceedsFrameLimit: !fitsAt(renderScale) };
}
