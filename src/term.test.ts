import { describe, expect, test } from "bun:test";
import { cc, ptr } from "bun:ffi";
import { closeSync, openSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Term, cellFromWinsize, parseCellSize, winsizeCell, type Key } from "./term.ts";

const ESC = "\x1b";

function capture(fn: () => void): string {
  const orig = process.stdout.write;
  let out = "";
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("latin1");
    return true;
  }) as typeof process.stdout.write;
  try {
    fn();
  } finally {
    process.stdout.write = orig;
  }
  return out;
}

describe("parseCellSize", () => {
  test("parses H,W / HxW / surrounding whitespace", () => {
    expect(parseCellSize("31,14")).toEqual({ cellHpx: 31, cellWpx: 14 });
    expect(parseCellSize("31x14")).toEqual({ cellHpx: 31, cellWpx: 14 });
    expect(parseCellSize("  31,14 ")).toEqual({ cellHpx: 31, cellWpx: 14 });
  });

  test("unset, malformed, non-positive, and out-of-range all yield null", () => {
    expect(parseCellSize(undefined)).toBeNull();
    expect(parseCellSize("")).toBeNull();
    expect(parseCellSize("31")).toBeNull();
    expect(parseCellSize("0,14")).toBeNull();
    expect(parseCellSize("31,-1")).toBeNull();
    expect(parseCellSize("abc")).toBeNull();
    expect(parseCellSize("2000,14")).toBeNull();
    expect(parseCellSize("999999999999999999999,14")).toBeNull();
  });
});

// Exercise the real FFI path so wiring failures do not silently become null.
describe("winsizeCell", () => {
  test.skipIf(process.platform !== "darwin")("derives the cell px from a PTY's dimensions, and a non-TTY fd yields null", () => {
    const pty = cc({
      source: fileURLToPath(new URL("./winsize.test.c", import.meta.url)),
      symbols: { mdpx_test_pty: { args: ["u16", "u16", "u16", "u16", "ptr"], returns: "int" } },
    }).symbols;
    const masterAndSlaveFds = new Int32Array(2);
    expect(pty.mdpx_test_pty(40, 100, 1400, 1240, ptr(masterAndSlaveFds))).toBe(0);
    const [masterFd, slaveFd] = masterAndSlaveFds;
    const file = openSync(fileURLToPath(import.meta.url), "r");
    try {
      expect(winsizeCell(slaveFd!)).toEqual({ cellHpx: 31, cellWpx: 14 });
      expect(winsizeCell(file)).toBeNull();
    } finally {
      for (const fd of [slaveFd!, masterFd!, file]) closeSync(fd);
    }
  });

  test.skipIf(process.platform === "darwin")("non-darwin yields null without attempting the ioctl", () => {
    expect(winsizeCell(0)).toBeNull();
  });
});

describe("cellFromWinsize", () => {
  test("derives the cell px from rows/cols and xpixel/ypixel (the TIOCGWINSZ fallback)", () => {
    expect(cellFromWinsize(65, 217, 3038, 2015)).toEqual({ cellHpx: 31, cellWpx: 14 });
  });

  test("zero pixel dimensions (a terminal that reports no pixels) yield null", () => {
    expect(cellFromWinsize(65, 217, 0, 0)).toBeNull();
    expect(cellFromWinsize(65, 217, 3038, 0)).toBeNull();
  });

  test("zero rows/cols yield null (never creating a division by zero)", () => {
    expect(cellFromWinsize(0, 217, 3038, 2015)).toBeNull();
    expect(cellFromWinsize(65, 0, 3038, 2015)).toBeNull();
  });

  test("garbled out-of-range values yield null", () => {
    expect(cellFromWinsize(1, 1, 99999, 99999)).toBeNull();
  });
});

describe("Term.enterAltScreen", () => {
  test("the initial output still carries CSI 2J", () => {
    const term = new Term();
    const out = capture(() => term.enterAltScreen());
    expect(out).toContain(`${ESC}[2J`);
  });
});

function inject(term: Term, seq: string): void {
  (term as unknown as { feed(b: Buffer): void }).feed(Buffer.from(seq, "latin1"));
}

describe("Term.queryKittyGraphics", () => {
  test("sends the graphics query as a=q plus a Primary DA (sync marker)", async () => {
    const term = new Term();
    let p!: Promise<boolean>;
    const out = capture(() => {
      p = term.queryKittyGraphics(1000);
    });
    expect(out).toContain(`${ESC}_G`);
    expect(out).toContain("a=q");
    expect(out.endsWith(`${ESC}[c`)).toBe(true);
    inject(term, `${ESC}[?62;c`);
    await p;
  });

  test("a _G reply arriving first means supported (true)", async () => {
    const term = new Term();
    let p!: Promise<boolean>;
    capture(() => {
      p = term.queryKittyGraphics(1000);
    });
    inject(term, `${ESC}_Gi=31;OK${ESC}\\${ESC}[?62;c`);
    expect(await p).toBe(true);
  });

  test("only a DA and no _G means unsupported (false)", async () => {
    const term = new Term();
    let p!: Promise<boolean>;
    capture(() => {
      p = term.queryKittyGraphics(1000);
    });
    inject(term, `${ESC}[?62;c`);
    expect(await p).toBe(false);
  });

  test("no reply times out as unsupported (false)", async () => {
    const term = new Term();
    let p!: Promise<boolean>;
    capture(() => {
      p = term.queryKittyGraphics(20);
    });
    expect(await p).toBe(false);
  });
});

function keyRecorder(): { term: Term; keys: Key[]; feed(s: string): void } {
  const term = new Term();
  const keys: Key[] = [];
  term.onKey((k) => keys.push(k));
  return { term, keys, feed: (s: string) => inject(term, s) };
}

const lines = (n: number): Key => ({ type: "scroll", delta: { kind: "lines", n } });
const halfpage = (dir: 1 | -1): Key => ({ type: "scroll", delta: { kind: "halfpage", dir } });

describe("Term key input", () => {
  test("q/ctrl-c/j/k/space/ctrl-d/ctrl-u/g/G", () => {
    const r = keyRecorder();
    r.feed("qjk \x04\x15gG\x03");
    expect(r.keys).toEqual([
      { type: "quit" },
      lines(1),
      lines(-1),
      halfpage(1),
      halfpage(1),
      halfpage(-1),
      { type: "scroll", delta: { kind: "top" } },
      { type: "scroll", delta: { kind: "bottom" } },
      { type: "quit" },
    ]);
  });

  test("arrows are picked up as both CSI (ESC[A/B) and SS3 (ESC O A/B)", () => {
    const r = keyRecorder();
    r.feed(`${ESC}[A${ESC}[B${ESC}OA${ESC}OB`);
    expect(r.keys).toEqual([lines(-1), lines(1), lines(-1), lines(1)]);
  });

  test("an arrow split across chunks is reassembled", () => {
    const r = keyRecorder();
    r.feed(`${ESC}`);
    r.feed("[");
    r.feed("B");
    expect(r.keys).toEqual([lines(1)]);
  });

  test("a lone ESC consumes one byte only and does not swallow the next key", () => {
    const r = keyRecorder();
    r.feed(`${ESC}j`);
    expect(r.keys).toEqual([lines(1)]);
  });

  test("a Ctrl-C inside an unfinished CSI is not eaten and can still quit", () => {
    const r = keyRecorder();
    r.feed(`${ESC}[3\x03`);
    expect(r.keys).toEqual([{ type: "quit" }]);
  });

  test("16t and DA replies are never emitted as keys", () => {
    const r = keyRecorder();
    r.feed(`${ESC}[6;31;14t${ESC}[?62;c`);
    expect(r.keys).toEqual([]);
  });

  test("the payload of a kitty graphics reply (APC) does not misfire as keys", () => {
    const r = keyRecorder();
    r.feed(`${ESC}_Gi=31;quit-glyphs-jkgG${ESC}\\q`);
    expect(r.keys).toEqual([{ type: "quit" }]);
  });
});

describe("Term parser resynchronization (unterminated sequences)", () => {
  test("an APC whose terminator never comes is dropped past the size limit, letting later keys through", () => {
    const r = keyRecorder();
    r.feed(`${ESC}_Gstuck`);
    expect(r.keys).toEqual([]);
    r.feed("x".repeat(300));
    r.feed("q");
    expect(r.keys).toEqual([{ type: "quit" }]);
  });

  test("an APC whose terminator never comes is dropped on time once input goes quiet", async () => {
    const r = keyRecorder();
    r.feed(`${ESC}_Gstuck`);
    r.feed("q");
    expect(r.keys).toEqual([]);
    await Bun.sleep(300);
    r.feed("q");
    expect(r.keys).toEqual([{ type: "quit" }]);
  });

  test("an ST arriving later is skipped as usual (a legitimately split reply is not broken)", () => {
    const r = keyRecorder();
    r.feed(`${ESC}_Gi=31;OK`);
    r.feed(`${ESC}\\j`);
    expect(r.keys).toEqual([lines(1)]);
  });
});

describe("Term.geometry wiring", () => {
  const cell = { cellHpx: 31, cellWpx: 14 };

  test("an unrelayed terminal stays at 1:1 with imgWidthPx matching the screen width", () => {
    const g = new Term().geometry(cell, false);
    expect(g.renderScale).toBe(2);
    expect(g.relayOverflow).toBe(false);
    expect(g.imgWidthPx).toBe(g.cols * cell.cellWpx);
  });

  test("a width that does not fit a herdr pane downscales, halving imgWidthPx too", () => {
    const full = new Term().geometry(cell, false);
    const relayed = new Term().geometry(cell, true);
    if (relayed.renderScale === 2) return;
    expect(relayed.renderScale).toBe(1);
    expect(relayed.imgWidthPx).toBe(Math.round((full.cols * cell.cellWpx) / 2));
    expect(relayed.viewportWidthCssPx).toBe(full.viewportWidthCssPx);
  });
});
