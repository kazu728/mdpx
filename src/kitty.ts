// Escape generation for the kitty graphics protocol (§4.4). Pure functions.
// Writing to the terminal is the caller's job (so tests can capture the strings).

const ESC = "\x1b";
const APC_START = `${ESC}_G`;
const APC_END = `${ESC}\\`;

/** Chunk size for splitting the base64 payload (the kitty spec's maximum). */
export const CHUNK_SIZE = 4096;

/** Tile id space per generation. image id = gen*ID_STRIDE + tileIndex (§4.4). */
export const ID_STRIDE = 1024;

/**
 * Assign an image id from a generation and a tile index. gen starts at 1, so the id is always at
 * least 1 (kitty treats id=0 as invalid; gen*1024+tileIndex ≥ 1024).
 */
export function imageId(gen: number, tileIndex: number): number {
  return gen * ID_STRIDE + tileIndex;
}

/** Placement id for every tile. One tile has at most one placement per frame, so a constant suffices. */
export const PLACEMENT_ID = 1;

/**
 * Transfer a PNG directly as base64 (a=t, f=100, t=d), in 4096-byte chunks continued with m=1/0.
 * q=1 suppresses only the success reply (why transfer outcomes are not tracked: runShoot in main.ts).
 * Called exactly once per tile per generation.
 */
export function transmit(id: number, pngBase64: string): string {
  const chunks: string[] = [];
  for (let i = 0; i < pngBase64.length; i += CHUNK_SIZE) {
    chunks.push(pngBase64.slice(i, i + CHUNK_SIZE));
  }
  let out = "";
  for (let idx = 0; idx < chunks.length; idx++) {
    const more = idx < chunks.length - 1 ? 1 : 0;
    const control =
      idx === 0 ? `a=t,f=100,t=d,i=${id},q=1,m=${more}` : `m=${more}`;
    out += `${APC_START}${control};${chunks[idx]}${APC_END}`;
  }
  return out;
}

export interface PlaceParams {
  id: number;
  /** Source rect (pixel coordinates within the image). */
  srcX: number;
  srcY: number;
  srcW: number;
  srcH: number;
  /**
   * Cells to display in. The terminal scales the source rect to fit this cell rectangle.
   * At 1:1 (§4.8) `srcH = rows * cellHpx` makes it 1:1, but with a reduced capture resolution the
   * source rect is half the screen px, making it 1:2. **Image px and cell counts are different units.**
   */
  cols: number;
  rows: number;
}

/**
 * Place an image's source rect at the cursor (a=p): x,y,w,h give the rectangle within the image and
 * c,r the display cell count. Scrolling is done purely by issuing this placement command (no re-transfer).
 */
export function place(p: PlaceParams): string {
  const control = `a=p,i=${p.id},p=${PLACEMENT_ID},x=${p.srcX},y=${p.srcY},w=${p.srcW},h=${p.srcH},c=${p.cols},r=${p.rows},q=1`;
  return `${APC_START}${control}${APC_END}`;
}

/** Delete just one placement, keeping the image data. Used to re-place on every frame (§4.5). */
export function deletePlacement(id: number): string {
  return `${APC_START}a=d,d=i,i=${id},p=${PLACEMENT_ID}${APC_END}`;
}

/**
 * Delete an image along with its placements and free the data (d=I). Used to clear out the old
 * generation on a switch. It frees the data rather than deleting only the placement (lowercase d=i)
 * in order to keep image storage down (the same aim as §4.4's tile cap).
 */
export function deleteImage(id: number): string {
  return `${APC_START}a=d,d=I,i=${id}${APC_END}`;
}

/** Delete every image and placement along with their data (d=A). For cleanup on exit (§4.6). */
export function deleteAll(): string {
  return `${APC_START}a=d,d=A${APC_END}`;
}
