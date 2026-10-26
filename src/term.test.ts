import { afterEach, beforeEach, describe, expect, jest, spyOn, test } from "bun:test";
import { deleteAll, deletePlacement, imageId, place } from "./kitty.ts";
import { renderFrame, sanitizeTerminalBlock, Term, type Key } from "./term.ts";
import { computeTiles, contentRows, type Geometry } from "./geometry.ts";
import type { ViewState } from "./scheduler.ts";
import { GEO } from "./test-geometry.ts";

const ESC = "\x1b";
const REDUCED: Geometry = { ...GEO, imgWidthPx: 400, renderScale: 0.5 };

function view(documentHeightPx: number, overrides: Partial<ViewState> = {}): ViewState {
  const geometry = overrides.geometry ?? GEO;
  const { tiles, contentHeightPx } = computeTiles(
    documentHeightPx,
    geometry.cellHpx,
    contentRows(geometry.rows),
    geometry.tileHeightPx,
  );
  return {
    geometry,
    scrollPx: 0,
    phase: "ready",
    failure: false,
    pendingScrollPx: null,
    displayGen: { gen: 1, tiles, resident: new Set(tiles.keys()), truncated: false, contentHeightPx },
    ...overrides,
  };
}

function statusLine(v: ViewState, filename = "a.md"): string {
  return renderFrame(v, filename, []).escape.match(/\x1b\[7m(.*)\x1b\[0m/s)![1]!;
}

describe("Term", () => {
  let written: string[];

  beforeEach(() => {
    written = [];
    spyOn(process.stdout, "write").mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    // A non-TTY stdin has no setRawMode for restore() to call.
    Object.defineProperty(process.stdin, "setRawMode", { value: () => process.stdin, configurable: true });
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    Reflect.deleteProperty(process.stdin, "setRawMode");
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
      t.input(`jk ${ESC}[A${ESC}OB`);
      expect(t.keys).toEqual([halfpage(1), lines(-1), lines(1)]);
    });

    test("a sequence split across reads is reassembled", () => {
      const t = terminal();
      for (const chunk of [ESC, "[", "B"]) t.input(chunk);
      expect(t.keys).toEqual([lines(1)]);
    });

    test("a lone ESC does not swallow the next key", () => {
      const t = terminal();
      t.input(`${ESC} `);
      expect(t.keys).toEqual([halfpage(1)]);
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
    test("enters with alternate scroll and a full clear, and restore undoes it", () => {
      const term = new Term();
      term.restore();
      expect(written).toEqual([]);
      term.enterAltScreen();
      expect(written.join("")).toBe(`${ESC}[?1049h${ESC}[?1007h${ESC}[?25l${ESC}[2J`);
      written.length = 0;
      term.restore();
      expect(written.join("")).toBe(`${deleteAll()}${ESC}[?25h${ESC}[?1007l${ESC}[?1049l`);
    });
  });

  describe("sanitizeTerminalBlock", () => {
    test("keeps newlines and tabs but neutralizes other control characters", () => {
      expect(sanitizeTerminalBlock(`Error: ${ESC}[31mx\n  at f\t(a.ts)\r`)).toBe("Error: ?[31mx\n  at f\t(a.ts)?");
      expect(sanitizeTerminalBlock("café❤️.md")).toBe("café❤️.md");
    });
  });
});

describe("renderFrame", () => {
  test("replaces the previous placements without clearing the stored images", () => {
    const first = renderFrame(view(300), "a.md", []);
    expect(first.placements).toEqual([imageId(1, 0)]);
    expect(first.escape).toContain("x=0,y=0,w=800,h=300,c=80,r=30");
    const { escape } = renderFrame(view(300), "a.md", first.placements);
    expect(escape.startsWith(`${ESC}[?2026h`)).toBe(true);
    expect(escape.endsWith(`${ESC}[?2026l`)).toBe(true);
    expect(escape).not.toContain(`${ESC}[2J`);
    expect(escape).not.toContain("d=I");
    const erase = escape.indexOf(`${ESC}[H${ESC}[J`);
    const unplace = escape.indexOf(deletePlacement(imageId(1, 0)));
    expect(unplace).toBeGreaterThan(-1);
    expect(unplace).toBeLessThan(erase);
    expect(escape.indexOf("a=p,")).toBeGreaterThan(erase);
  });

  test("crops tiles in image pixels when the capture is downscaled", () => {
    const { escape } = renderFrame(view(3000, { geometry: REDUCED, scrollPx: 520 }), "a.md", []);
    const crop = (tileIndex: number, y: number, h: number, rows: number) =>
      place({
        id: imageId(1, tileIndex),
        sourceXImagePx: 0,
        sourceYImagePx: y,
        sourceWidthImagePx: 400,
        sourceHeightImagePx: h,
        displayColumns: 80,
        displayRows: rows,
      });
    expect(escape).toContain(`${ESC}[1;1H${crop(1, 10, 240, 48)}`);
    expect(escape).toContain(`${ESC}[49;1H${crop(2, 0, 10, 2)}`);
  });
});

describe("status bar", () => {
  test("fills exactly the terminal width, dropping q:quit when it does not fit", () => {
    const wide = statusLine(view(300), "👨‍👩‍👧.md");
    expect(Bun.stringWidth(wide)).toBe(GEO.cols);
    expect(wide.endsWith("q:quit")).toBe(true);
    const narrow = statusLine(view(300, { geometry: { ...GEO, cols: 12 } }), "a".repeat(40) + ".md");
    expect(Bun.stringWidth(narrow)).toBe(12);
    expect(narrow).not.toContain("q:quit");
  });

  test("never splits a grapheme or a full-width character in the file name", () => {
    expect(statusLine(view(300, { geometry: { ...GEO, cols: 5 } }), "❤️０１２.md")).toBe("❤️０ ");
  });

  test("control characters in the file name are neutralized", () => {
    expect(statusLine(view(300), `x${ESC}[31m\n\t.md`).startsWith("x?[31m??.md")).toBe(true);
  });

  test("shows activity before failure before truncation", () => {
    const shown = view(300);
    expect(statusLine({ ...shown, pendingScrollPx: 0, phase: "rendering", failure: true })).toContain("scrolling…");
    expect(statusLine({ ...shown, phase: "rendering", failure: true })).toContain("updating");
    expect(statusLine({ ...shown, displayGen: null, phase: "rendering" })).toContain("rendering…");
    expect(statusLine({ ...shown, displayGen: null, failure: true })).toContain("render failed");
    const long = view(3000);
    const truncated = { ...long, displayGen: { ...long.displayGen!, truncated: true } };
    expect(statusLine({ ...truncated, scrollPx: 2500 })).toContain("truncated");
    expect(statusLine({ ...truncated, scrollPx: 2490 })).not.toContain("truncated");
  });

  test("a downscaled capture is marked low-res", () => {
    expect(statusLine(view(300, { geometry: REDUCED }))).toContain("low-res");
    expect(statusLine(view(300))).not.toContain("low-res");
  });
});
