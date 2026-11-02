const ESC = "\x1b";
const APC_START = `${ESC}_G`;
const APC_END = `${ESC}\\`;

const MAX_PAYLOAD_CHUNK_SIZE = 4096;

export function transmit(id: number, pngBase64: string): string {
  let out = "";
  for (let i = 0; i < pngBase64.length; i += MAX_PAYLOAD_CHUNK_SIZE) {
    const more = i + MAX_PAYLOAD_CHUNK_SIZE < pngBase64.length ? 1 : 0;
    const control = i === 0 ? `a=t,f=100,t=d,i=${id},q=1,m=${more}` : `m=${more}`;
    out += `${APC_START}${control};${pngBase64.slice(i, i + MAX_PAYLOAD_CHUNK_SIZE)}${APC_END}`;
  }
  return out;
}

export function transferSize(dataLenBytes: number): number {
  const base64Len = Math.ceil(dataLenBytes / 3) * 4;
  return base64Len + Math.ceil(base64Len / MAX_PAYLOAD_CHUNK_SIZE) * 16 + 1024;
}

interface PlaceParams {
  id: number;
  placementId: number;
  sourceXImagePx: number;
  sourceYImagePx: number;
  sourceWidthImagePx: number;
  sourceHeightImagePx: number;
  displayColumns: number;
  displayRows: number;
}

export function place(p: PlaceParams): string {
  const control = `a=p,i=${p.id},p=${p.placementId},x=${p.sourceXImagePx},y=${p.sourceYImagePx},w=${p.sourceWidthImagePx},h=${p.sourceHeightImagePx},c=${p.displayColumns},r=${p.displayRows},q=1`;
  return `${APC_START}${control}${APC_END}`;
}

export function deletePlacement(id: number, placementId: number): string {
  return `${APC_START}a=d,d=i,i=${id},p=${placementId}${APC_END}`;
}

export function deleteImage(id: number): string {
  return `${APC_START}a=d,d=I,i=${id}${APC_END}`;
}

export function deleteAll(): string {
  return `${APC_START}a=d,d=A${APC_END}`;
}
