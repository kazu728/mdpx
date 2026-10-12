import { afterEach, beforeEach, describe, expect, jest, spyOn, test } from "bun:test";
import { deleteAll } from "./kitty.ts";
import { sanitizeTerminalBlock, Term, type Key } from "./term.ts";

const ESC = "\x1b";

let written: string[];

beforeEach(() => {
  written = [];
  spyOn(process.stdout, "write").mockImplementation((chunk) => {
    written.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

function terminal(): { term: Term; keys: Key[]; input(s: string): void } {
  const term = new Term();
  const keys: Key[] = [];
  term.onKey((k) => keys.push(k));
  const feed = (term as unknown as { feed(b: Buffer): void }).feed.bind(term);
  return { term, keys, input: (s) => feed(Buffer.from(s, "latin1")) };
}

const lines = (n: number): Key => ({ type: "scroll", delta: { kind: "lines", n } });
const halfpage = (dir: 1 | -1): Key => ({ type: "scroll", delta: { kind: "halfpage", dir } });
const QUIT: Key = { type: "quit" };

const BINDINGS: [string, Key][] = [
  ["q", QUIT],
  ["\x03", QUIT],
  ["t", { type: "theme" }],
  ["j", lines(1)],
  ["k", lines(-1)],
  [`${ESC}[B`, lines(1)],
  [`${ESC}[A`, lines(-1)],
  [`${ESC}OB`, lines(1)],
  [`${ESC}OA`, lines(-1)],
  [" ", halfpage(1)],
  ["\x04", halfpage(1)],
  ["\x15", halfpage(-1)],
  ["g", { type: "scroll", delta: { kind: "top" } }],
  ["G", { type: "scroll", delta: { kind: "bottom" } }],
];

describe("key input", () => {
  test("each key acts as soon as it is read", () => {
    const t = terminal();
    for (const [input, key] of BINDINGS) {
      t.input(input);
      expect(t.keys.at(-1)).toEqual(key);
    }
    expect(t.keys).toHaveLength(BINDINGS.length);
  });

  test("keys arriving together in one read are all handled in order", () => {
    const t = terminal();
    t.input(`j${ESC}[A${ESC}OB`);
    expect(t.keys).toEqual([lines(1), lines(-1), lines(1)]);
  });

  test("a sequence split across reads is reassembled", () => {
    const t = terminal();
    for (const chunk of [ESC, "[", "B"]) t.input(chunk);
    expect(t.keys).toEqual([lines(1)]);
  });

  test("a lone ESC does not swallow the next key", () => {
    const t = terminal();
    t.input(`${ESC}j`);
    expect(t.keys).toEqual([lines(1)]);
  });

  test("Ctrl-C inside a malformed CSI still quits", () => {
    const t = terminal();
    t.input(`${ESC}[3\x03`);
    expect(t.keys).toEqual([QUIT]);
  });

  test("terminal replies and string payloads never fire keys", () => {
    const t = terminal();
    t.input(`${ESC}_Gi=31;quit-jkgG${ESC}\\${ESC}]0;jk\x07${ESC}[6;31;14t${ESC}[?62;cq`);
    expect(t.keys).toEqual([QUIT]);
    t.input(`${ESC}Pq${ESC}\\${ESC}[6;31;14tq`);
    expect(t.keys).toEqual([QUIT, QUIT]);
  });

  test("an unterminated sequence is dropped once it grows too long or goes quiet", () => {
    jest.useFakeTimers();
    const long = terminal();
    long.input(`${ESC}_Gstuck`);
    long.input("x".repeat(300));
    long.input("q");
    expect(long.keys).toEqual([QUIT]);

    const quiet = terminal();
    quiet.input(`${ESC}_Gstuck`);
    quiet.input("q");
    expect(quiet.keys).toEqual([]);
    jest.advanceTimersByTime(200);
    quiet.input("q");
    expect(quiet.keys).toEqual([QUIT]);
  });
});

describe("queryCellSize", () => {
  test("accepts only whole-pixel cell sizes", async () => {
    const reply = (seq: string) => {
      const t = terminal();
      const size = t.term.queryCellSize(1000);
      t.input(seq);
      return size;
    };
    expect(await reply(`${ESC}[6;31;14t`)).toEqual({ cellHpx: 31, cellWpx: 14 });
    expect(written.at(-1)).toBe(`${ESC}[16t`);
    expect(await reply(`${ESC}[6;20;0.4t`)).toBeNull();
    expect(await reply(`${ESC}[6;20.5;10t`)).toBeNull();
  });
});

describe("queryKittyGraphics", () => {
  test("supported only when a graphics reply precedes the Primary DA", async () => {
    const probe = (seq: string | null) => {
      const t = terminal();
      const supported = t.term.queryKittyGraphics(seq === null ? 20 : 1000);
      if (seq !== null) t.input(seq);
      return supported;
    };
    expect(await probe(`${ESC}_Gi=31;OK${ESC}\\${ESC}[?62;c`)).toBe(true);
    expect(written.at(-1)).toMatch(/^\x1b_G[^;]*\ba=q\b[^;]*;[^\x1b]*\x1b\\\x1b\[c$/);
    expect(await probe(`${ESC}[?62;c`)).toBe(false);
    expect(await probe(null)).toBe(false);
  });
});

describe("alternate screen", () => {
  test("enters with alternate scroll and a full clear, and restore undoes it once", () => {
    const term = new Term();
    term.restore();
    expect(written).toEqual([]);
    term.enterAltScreen();
    expect(written.join("")).toBe(`${ESC}[?1049h${ESC}[?1007h${ESC}[?25l${ESC}[2J`);
    written.length = 0;
    term.restore();
    expect(written.join("")).toBe(`${deleteAll()}${ESC}[?25h${ESC}[?1007l${ESC}[?1049l`);
    written.length = 0;
    term.restore();
    expect(written).toEqual([]);
  });
});

describe("sanitizeTerminalBlock", () => {
  test("keeps newlines and tabs but neutralizes other control characters", () => {
    expect(sanitizeTerminalBlock(`Error: ${ESC}[31mx\n  at f\t(a.ts)\r`)).toBe("Error: ?[31mx\n  at f\t(a.ts)?");
    expect(sanitizeTerminalBlock("café❤️.md")).toBe("café❤️.md");
  });
});
