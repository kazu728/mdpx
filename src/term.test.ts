import { describe, expect, test } from "bun:test";
import { Term, type Key } from "./term.ts";

const ESC = "\x1b";

function capture(fn: () => void): string {
  const orig = process.stdout.write;
  let out = "";
  process.stdout.write = ((c: string | Uint8Array) => {
    out += typeof c === "string" ? c : Buffer.from(c).toString("latin1");
    return true;
  }) as typeof process.stdout.write;
  try {
    fn();
  } finally {
    process.stdout.write = orig;
  }
  return out;
}

describe("Term.enterAltScreen", () => {
  test("alt screen + alternate scroll, released on restore", () => {
    expect(capture(() => new Term().enterAltScreen())).toContain(`${ESC}[2J`);
    expect(capture(() => new Term().enterAltScreen())).toContain(`${ESC}[?1007h`);
    const term = new Term();
    capture(() => term.enterAltScreen());
    expect(capture(() => term.restore())).toContain(`${ESC}[?1007l`);
  });
});

function inject(term: Term, seq: string): void {
  (term as unknown as { feed(b: Buffer): void }).feed(Buffer.from(seq, "latin1"));
}

describe("Term.queryKittyGraphics", () => {
  test("sends a=q plus Primary DA", async () => {
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

  test("_G first means supported", async () => {
    const term = new Term();
    let p!: Promise<boolean>;
    capture(() => {
      p = term.queryKittyGraphics(1000);
    });
    inject(term, `${ESC}_Gi=31;OK${ESC}\\${ESC}[?62;c`);
    expect(await p).toBe(true);
  });

  test("DA only or timeout means unsupported", async () => {
    const term = new Term();
    let p!: Promise<boolean>;
    capture(() => {
      p = term.queryKittyGraphics(1000);
    });
    inject(term, `${ESC}[?62;c`);
    expect(await p).toBe(false);
    const t2 = new Term();
    let p2!: Promise<boolean>;
    capture(() => {
      p2 = t2.queryKittyGraphics(20);
    });
    expect(await p2).toBe(false);
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

  test("arrows via CSI and SS3", () => {
    const r = keyRecorder();
    r.feed(`${ESC}[A${ESC}[B${ESC}OA${ESC}OB`);
    expect(r.keys).toEqual([lines(-1), lines(1), lines(-1), lines(1)]);
  });

  test("split arrow reassembles", () => {
    const r = keyRecorder();
    r.feed(`${ESC}`);
    r.feed("[");
    r.feed("B");
    expect(r.keys).toEqual([lines(1)]);
  });

  test("lone ESC takes one byte only", () => {
    const r = keyRecorder();
    r.feed(`${ESC}j`);
    expect(r.keys).toEqual([lines(1)]);
  });

  test("ctrl-C inside CSI still quits", () => {
    const r = keyRecorder();
    r.feed(`${ESC}[3\x03`);
    expect(r.keys).toEqual([{ type: "quit" }]);
  });

  test("16t and DA never emit keys", () => {
    const r = keyRecorder();
    r.feed(`${ESC}[6;31;14t${ESC}[?62;c`);
    expect(r.keys).toEqual([]);
  });

  test("kitty APC payload does not misfire", () => {
    const r = keyRecorder();
    r.feed(`${ESC}_Gi=31;quit-glyphs-jkgG${ESC}\\q`);
    expect(r.keys).toEqual([{ type: "quit" }]);
  });
});

describe("Term resync (unterminated sequences)", () => {
  test("stuck APC drops (size limit or quiet timeout)", async () => {
    const r = keyRecorder();
    r.feed(`${ESC}_Gstuck`);
    expect(r.keys).toEqual([]);
    r.feed("x".repeat(300));
    r.feed("q");
    expect(r.keys).toEqual([{ type: "quit" }]);
    const r2 = keyRecorder();
    r2.feed(`${ESC}_Gstuck`);
    r2.feed("q");
    expect(r2.keys).toEqual([]);
    await Bun.sleep(300);
    r2.feed("q");
    expect(r2.keys).toEqual([{ type: "quit" }]);
  });

  test("late ST is skipped (split reply unbroken)", () => {
    const r = keyRecorder();
    r.feed(`${ESC}_Gi=31;OK`);
    r.feed(`${ESC}\\j`);
    expect(r.keys).toEqual([lines(1)]);
  });
});
