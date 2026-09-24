import { describe, expect, test } from "bun:test";
import {
  deleteAll,
  deleteImage,
  deletePlacement,
  imageId,
  MAX_PAYLOAD_CHUNK_SIZE,
  place,
  TILE_PLACEMENT_ID,
  transmit,
} from "./kitty.ts";

interface Apc {
  control: string;
  payload: string;
}
function parseApc(s: string): Apc[] {
  const out: Apc[] = [];
  const re = /\x1b_G([^;]*)(?:;([\s\S]*?))?\x1b\\/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push({ control: m[1]!, payload: m[2] ?? "" });
  return out;
}
function keys(control: string): Record<string, string> {
  return Object.fromEntries(
    control.split(",").map((kv) => {
      const [k, v] = kv.split("=");
      return [k!, v ?? ""];
    }),
  );
}

describe("transmit", () => {
  test("chunks at 4096 with m flag, single chunk otherwise", () => {
    const b64 = "A".repeat(MAX_PAYLOAD_CHUNK_SIZE * 2 + 10);
    const apcs = parseApc(transmit(imageId(3, 1), b64));
    expect(apcs).toHaveLength(3);
    expect(apcs[0]!.payload.length).toBe(MAX_PAYLOAD_CHUNK_SIZE);
    expect(apcs[1]!.payload.length).toBe(MAX_PAYLOAD_CHUNK_SIZE);
    expect(apcs[2]!.payload.length).toBe(10);
    expect(keys(apcs[0]!.control)).toMatchObject({ a: "t", f: "100", t: "d", i: String(imageId(3, 1)), q: "1", m: "1" });
    expect(keys(apcs[2]!.control).m).toBe("0");
    expect(apcs[1]!.control).toBe("m=1");
    const single = parseApc(transmit(1024, "Zm9v"));
    expect(single).toHaveLength(1);
    expect(keys(single[0]!.control).m).toBe("0");
    expect(single[0]!.payload).toBe("Zm9v");
  });
});

describe("place", () => {
  test("source rect and display cells", () => {
    const s = place({
      id: 2053,
      sourceXImagePx: 0,
      sourceYImagePx: 120,
      sourceWidthImagePx: 3024,
      sourceHeightImagePx: 620,
      displayColumns: 216,
      displayRows: 20,
    });
    const [apc] = parseApc(s);
    expect(keys(apc!.control)).toMatchObject({
      a: "p", i: "2053", p: String(TILE_PLACEMENT_ID),
      x: "0", y: "120", w: "3024", h: "620", c: "216", r: "20", q: "1",
    });
    expect(apc!.payload).toBe("");
  });
});

describe("delete", () => {
  test("placement/image/all use d=i/d=I/d=A", () => {
    expect(keys(parseApc(deletePlacement(2053))[0]!.control)).toMatchObject({
      a: "d", d: "i", i: "2053", p: String(TILE_PLACEMENT_ID),
    });
    expect(keys(parseApc(deleteImage(2053))[0]!.control)).toMatchObject({ a: "d", d: "I", i: "2053" });
    expect(keys(parseApc(deleteAll())[0]!.control)).toMatchObject({ a: "d", d: "A" });
  });
});
