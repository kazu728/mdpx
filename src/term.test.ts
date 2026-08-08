import { describe, expect, test } from "bun:test";
import { Term, parseCellSize, type Key } from "./term.ts";

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
  test("q/ctrl-c/t/j/k/space/ctrl-d/ctrl-u/g/G", () => {
    const r = keyRecorder();
    r.feed("qtjk \x04\x15gG\x03");
    expect(r.keys).toEqual([
      { type: "quit" },
      { type: "theme" },
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
