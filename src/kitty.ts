const ESC = "\x1b";
const APC_START = `${ESC}_G`;
const APC_END = `${ESC}\\`;

export const MAX_PAYLOAD_CHUNK_SIZE = 4096;

export const IMAGE_ID_GENERATION_STRIDE = 1024;

export function imageId(gen: number, tileIndex: number): number {
  return gen * IMAGE_ID_GENERATION_STRIDE + tileIndex;
}

export const TILE_PLACEMENT_ID = 1;

/** Transfer a PNG as base64 chunks; q=1 suppresses the success reply. */
export function transmit(id: number, pngBase64: string): string {
  const chunks: string[] = [];
  for (let i = 0; i < pngBase64.length; i += MAX_PAYLOAD_CHUNK_SIZE) {
    chunks.push(pngBase64.slice(i, i + MAX_PAYLOAD_CHUNK_SIZE));
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
  sourceXImagePx: number;
  sourceYImagePx: number;
  sourceWidthImagePx: number;
  sourceHeightImagePx: number;
  displayColumns: number;
  displayRows: number;
}

export function place(p: PlaceParams): string {
  const control = `a=p,i=${p.id},p=${TILE_PLACEMENT_ID},x=${p.sourceXImagePx},y=${p.sourceYImagePx},w=${p.sourceWidthImagePx},h=${p.sourceHeightImagePx},c=${p.displayColumns},r=${p.displayRows},q=1`;
  return `${APC_START}${control}${APC_END}`;
}

export function deletePlacement(id: number): string {
  return `${APC_START}a=d,d=i,i=${id},p=${TILE_PLACEMENT_ID}${APC_END}`;
}

export function deleteImage(id: number): string {
  return `${APC_START}a=d,d=I,i=${id}${APC_END}`;
}

export function deleteAll(): string {
  return `${APC_START}a=d,d=A${APC_END}`;
}
