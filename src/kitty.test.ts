import { describe, expect, test } from "bun:test";
import {
  deleteAll,
  deleteImage,
  deletePlacement,
  MAX_PAYLOAD_CHUNK_SIZE,
  place,
  TILE_PLACEMENT_ID,
  transmit,
} from "./kitty.ts";

function commands(escape: string): { keys: Record<string, string>; payload: string }[] {
  return [...escape.matchAll(/\x1b_G([^;\x1b]*)(?:;([^\x1b]*))?\x1b\\/g)].map((m) => ({
    keys: Object.fromEntries(m[1]!.split(",").map((kv) => kv.split("="))),
    payload: m[2] ?? "",
  }));
}

describe("transmit", () => {
  test("splits a PNG into chunks the terminal reassembles into one image", () => {
    const png = "A".repeat(MAX_PAYLOAD_CHUNK_SIZE * 2) + "B".repeat(10);
    const chunks = commands(transmit(7, png));
    expect(chunks.map((c) => c.payload).join("")).toBe(png);
    expect(chunks.every((c) => c.payload.length <= MAX_PAYLOAD_CHUNK_SIZE)).toBe(true);
    // Bun's toEqual treats { "1": undefined } as equal to { m: "1" }, so parsed keys are compared strictly.
    expect(chunks.map((c) => c.keys)).toStrictEqual([
      { a: "t", f: "100", t: "d", i: "7", q: "1", m: "1" },
      { m: "1" },
      { m: "0" },
    ]);

    const [single] = commands(transmit(7, "Zm9v"));
    expect(single!.keys).toMatchObject({ a: "t", i: "7", m: "0" });
  });
});

describe("place", () => {
  test("crops the source rect and scales it onto the display cells", () => {
    const [cmd] = commands(
      place({
        id: 2053,
        sourceXImagePx: 3,
        sourceYImagePx: 120,
        sourceWidthImagePx: 3024,
        sourceHeightImagePx: 620,
        displayColumns: 216,
        displayRows: 20,
      }),
    );
    expect(cmd!.keys).toStrictEqual({
      a: "p",
      i: "2053",
      p: String(TILE_PLACEMENT_ID),
      x: "3",
      y: "120",
      w: "3024",
      h: "620",
      c: "216",
      r: "20",
      q: "1",
    });
  });
});

describe("delete", () => {
  test("a placement delete keeps the image data; image and full deletes free it", () => {
    expect(commands(deletePlacement(2053))[0]!.keys).toStrictEqual({
      a: "d",
      d: "i",
      i: "2053",
      p: String(TILE_PLACEMENT_ID),
    });
    expect(commands(deleteImage(2053))[0]!.keys).toStrictEqual({ a: "d", d: "I", i: "2053" });
    expect(commands(deleteAll())[0]!.keys).toStrictEqual({ a: "d", d: "A" });
  });
});
