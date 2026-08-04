// Constraints for drawing inside a herdr pane (§4.8). Pure computation only.
//
// herdr composites a pane's kitty graphics itself, decoding the images of visible placements to RGBA
// and relaying them base64-encoded to the outer terminal. A transfer (`a=t`) sends the whole image
// and only a placement (`a=p`) can clip, so the relayed volume is a multiple of "one entire tile",
// not "the visible area". Past 32 MiB herdr drops the images wholesale and sends only text, leaving
// the body blank. mdpx fills the whole screen with images by design, so whether the limit is hit
// depends purely on the geometry.

/**
 * Cap on the graphics herdr will put in one client frame (bytes).
 * It is a constant in herdr's `src/protocol/wire.rs` and cannot be configured.
 */
const GRAPHICS_FRAME_LIMIT = 32 * 1024 * 1024;

/** Bytes relayed for one tile: RGBA at 4 bytes/px, sent as base64 (4/3). */
function relayBytes(imgWidthPx: number, tileHpx: number): number {
  return imgWidthPx * tileHpx * 4 * (4 / 3);
}

/**
 * Total kitty image data a terminal can hold (bytes). §4.4's resident tile count derives from this.
 *
 * herdr configures the pane terminal with 64 MiB (`KITTY_IMAGE_STORAGE_LIMIT_BYTES` in
 * `src/ghostty/mod.rs`). Plain Ghostty defaults `image-storage-limit` to 320 MB, so herdr narrows it
 * to a fifth. Both count images as **decoded pixels**, so even though mdpx sends PNG, the amount held
 * is `width × height × 4`.
 */
const IMAGE_STORAGE_LIMIT = { herdr: 64 * 1024 * 1024, ghostty: 320_000_000 };

/**
 * How many tiles may stay resident in the terminal (§4.4). Past the limit the terminal evicts the
 * oldest images, but mdpx has no way to learn that an image was evicted and the region silently
 * stays black. So rather than leave it to the terminal, mdpx keeps the working set inside a budget
 * and frees images itself before overflowing.
 *
 * `minTiles` is the number of simultaneously visible tiles. Going below it would make the visible
 * region itself unplaceable, so it is the floor.
 */
export function maxResidentTiles(tileBytes: number, relayed: boolean, minTiles: number): number {
  const limit = relayed ? IMAGE_STORAGE_LIMIT.herdr : IMAGE_STORAGE_LIMIT.ghostty;
  // The terminal also spends storage on placements and other bookkeeping, so do not claim the full limit
  const budget = Math.floor((limit * 0.8) / Math.max(1, tileBytes));
  return Math.max(minTiles, budget);
}

export function visibleTileCount(viewportHpx: number, tileHpx: number): number {
  return maxTilesInFrame(viewportHpx, tileHpx);
}

/**
 * Whether we are inside a herdr pane. herdr sets `HERDR_ENV=1` on child processes.
 * Unset, empty, and `0` all count as false (`"0"` is truthy in JS, so it is excluded explicitly).
 */
export function inHerdrPane(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.HERDR_ENV;
  return v !== undefined && v !== "" && v !== "0";
}

/**
 * Tiles that could be newly uploaded in one frame (§4.8).
 *
 * herdr remembers uploaded images by signature and puts only placement commands in later frames, so
 * what determines each frame's relay volume is not "visible tiles" but "visible tiles **not yet
 * sent**".
 *
 * **Count what it takes to cover one screen; do not add for straddling a boundary.** mdpx captures
 * tiles from Chrome one at a time and transfers each before the next, and herdr always draws a frame
 * within that round trip — so several tiles landing in the same frame does not actually happen
 * (measured: six generation switches in a 216-column pane, zero drops). Adding +1 for the straddle
 * would permanently force a resolution drop that is never needed.
 *
 * Should the assumption fail and two tiles land in one frame, that frame's images are dropped, but
 * scrolling changes the visible set and causes a resend, so it recovers.
 */
function maxTilesInFrame(viewportHpx: number, tileHpx: number): number {
  return Math.max(1, Math.ceil(Math.max(0, viewportHpx) / tileHpx));
}

export function fitsGraphicsFrame(imgWidthPx: number, tileHpx: number, tilesInFrame: number): boolean {
  return tilesInFrame * relayBytes(imgWidthPx, tileHpx) <= GRAPHICS_FRAME_LIMIT;
}

export interface RelayGeometry {
  /** Chrome's CSS viewport width. The image width becomes this × renderScale. */
  cssWidth: number;
  /** Tile height (screen px). */
  tileHpx: number;
  /** Height of the content area (screen px). Determines how many tiles are visible at once. */
  viewportHpx: number;
  /**
   * Scroll unit when downscaled (screen px). Downscaling widens this unit (to two cells when the cell
   * height is odd — §4.5), and a viewport shorter than the unit has no placeable position other than
   * 0, making the end of the document unreachable. Degrading that far gains nothing, so this decides
   * whether downscaling is allowed at all.
   */
  reducedScrollUnitPx: number;
  /**
   * The 1:1 deviceScaleFactor (= viewport.CSS_SCALE). It is taken as a value so this module need not
   * import the geometry module; only the call shape is independent. The reduced step is fixed at 1,
   * and the matching coordinate conversion references CSS_SCALE directly on the viewport side.
   */
  fullScale: number;
  /** Whether we are inside a herdr pane. Terminals without a relay have no limit. */
  relayed: boolean;
}

/**
 * Decide the capture resolution and whether it overflows even downscaled (§4.8).
 * Terminals without a relay (plain Ghostty and friends) always stay at 1:1. Only when relayed, and
 * only when 1:1 does not fit, does it drop to 1. There is just one reduction step, so if that still
 * does not fit there is nothing mdpx can do — that fact is surfaced as `relayOverflow` to explain the
 * blank screen.
 */
export function pickRenderScale(g: RelayGeometry): { renderScale: number; relayOverflow: boolean } {
  // The tile count follows a ratio of screen px and does not change when downscaling; only the byte
  // count depends on each step's image dimensions
  const tiles = maxTilesInFrame(g.viewportHpx, g.tileHpx);
  const fitsAt = (scale: number) =>
    fitsGraphicsFrame(g.cssWidth * scale, (g.tileHpx * scale) / g.fullScale, tiles);

  // Geometries whose unit would exceed the viewport gain nothing from degrading
  // (RelayGeometry.reducedScrollUnitPx), so they stay at 1:1
  const canReduce = g.relayed && g.viewportHpx >= g.reducedScrollUnitPx;
  const renderScale = !g.relayed || fitsAt(g.fullScale) || !canReduce ? g.fullScale : 1;
  return { renderScale, relayOverflow: g.relayed && !fitsAt(renderScale) };
}
