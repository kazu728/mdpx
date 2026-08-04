import { describe, expect, test } from "bun:test";
import { buildLineMap, countLines, lineAt, type Anchor } from "./linemap.ts";

describe("countLines", () => {
  // The same rule as nvim's line("$") (a trailing newline adds no line; empty still counts as 1)
  const cases: [string, number][] = [
    ["", 1],
    ["\n", 1],
    ["a", 1],
    ["a\n", 1],
    ["a\nb", 2],
    ["a\nb\n", 2],
    ["a\n\n", 2],
  ];
  for (const [src, expected] of cases) {
    test(`${JSON.stringify(src)} → ${expected}`, () => {
      expect(countLines(src)).toBe(expected);
    });
  }
});

describe("buildLineMap", () => {
  const build = (anchors: Anchor[], lineCount = 6, docCssH = 400) =>
    buildLineMap(anchors, lineCount, docCssH).anchors;

  test("closed by the virtual anchors {1,0} at the head and {lineCount+1, docCssH} at the tail", () => {
    expect(build([{ line: 3, top: 100 }])).toEqual([
      { line: 1, top: 0 },
      { line: 3, top: 100 },
      { line: 7, top: 400 },
    ]);
  });

  test("holds up on the two ends alone when there is not a single anchor", () => {
    expect(build([])).toEqual([
      { line: 1, top: 0 },
      { line: 7, top: 400 },
    ]);
  });

  test("drops anchors whose line goes backwards (elements like footnotes, where document order diverges from source order)", () => {
    const out = build([
      { line: 3, top: 100 },
      { line: 2, top: 150 },
      { line: 5, top: 200 },
    ]);
    expect(out.map((a) => a.line)).toEqual([1, 3, 5, 7]);
  });

  test("drops duplicates pointing at the same line (a list_item and the paragraph inside it)", () => {
    const out = build([
      { line: 3, top: 100 },
      { line: 3, top: 110 },
      { line: 4, top: 130 },
    ]);
    expect(out.map((a) => a.top)).toEqual([0, 100, 130, 400]);
  });

  test("drops anchors whose top goes backwards", () => {
    const out = build([
      { line: 3, top: 200 },
      { line: 4, top: 150 },
      { line: 5, top: 250 },
    ]);
    expect(out.map((a) => a.line)).toEqual([1, 3, 5, 7]);
  });

  test("drops anchors whose top exceeds docCssH", () => {
    const out = build([
      { line: 3, top: 100 },
      { line: 4, top: 500 },
    ]);
    expect(out.map((a) => a.line)).toEqual([1, 3, 7]);
  });

  test("a head anchor (line 1, top 0) is dropped as a duplicate of the virtual one", () => {
    const out = build([
      { line: 1, top: 0 },
      { line: 3, top: 100 },
    ]);
    expect(out.map((a) => a.line)).toEqual([1, 3, 7]);
  });

  test("drops NaN and Infinity", () => {
    const out = build([
      { line: NaN, top: 50 },
      { line: 3, top: Infinity },
      { line: 4, top: 200 },
    ]);
    expect(out.map((a) => a.line)).toEqual([1, 4, 7]);
  });

  test("no tail anchor is added when docCssH equals the last anchor (never creating a zero slope)", () => {
    const out = buildLineMap([{ line: 3, top: 400 }], 6, 400).anchors;
    expect(out).toEqual([
      { line: 1, top: 0 },
      { line: 3, top: 400 },
    ]);
  });

  test("both line and top come out strictly increasing", () => {
    const out = build([
      { line: 5, top: 300 },
      { line: 2, top: 50 },
      { line: 5, top: 320 },
      { line: 3, top: 100 },
      { line: 9, top: 380 },
    ]);
    for (let i = 1; i < out.length; i++) {
      expect(out[i]!.line).toBeGreaterThan(out[i - 1]!.line);
      expect(out[i]!.top).toBeGreaterThan(out[i - 1]!.top);
    }
  });
});

describe("lineAt", () => {
  // Anchors: {1,0} {3,100} {5,300} {7,400} (lineCount = 6)
  const map = buildLineMap(
    [
      { line: 3, top: 100 },
      { line: 5, top: 300 },
    ],
    6,
    400,
  );

  const cases: [string, number, number][] = [
    ["the top is line 1 (no special case needed)", 0, 1],
    ["inside a block it interpolates proportionally to px", 50, 2],
    ["an anchor position is exact", 100, 3],
    ["it keeps advancing through a long block", 200, 4],
    ["the next anchor position", 300, 5],
    ["partway through the final block", 350, 6],
    ["the bottom of the document clamps to lineCount", 400, 6],
    ["past the bottom is lineCount too", 10_000, 6],
    ["past the top is line 1", -50, 1],
  ];
  for (const [name, cssY, expected] of cases) {
    test(name, () => {
      expect(lineAt(map, cssY, false)).toBe(expected);
    });
  }

  test("atEnd gives the document's last line, not the interpolated value (`G` means \"end of the document\", not \"first line of the last screen\")", () => {
    expect(lineAt(map, 0, true)).toBe(6);
    expect(lineAt(map, 350, true)).toBe(6);
  });

  test("clamps even when an anchor points past lineCount", () => {
    const m = buildLineMap([{ line: 99, top: 100 }], 4, 400);
    expect(lineAt(m, 200, false)).toBe(4);
  });

  test("returns a line across the whole range with only the two virtual anchors", () => {
    const m = buildLineMap([], 10, 200);
    expect(lineAt(m, 0, false)).toBe(1);
    expect(lineAt(m, 100, false)).toBe(6);
    expect(lineAt(m, 200, false)).toBe(10);
  });
});

// A line that takes a line in the source but has no place in the rendering (a blank line, say) can
// become the landing point because the interpolation apportions px to it. Passing laidOut keeps it
// from landing there (§4.9).
describe("lineAt's laidOut snapping", () => {
  // Lines 2 and 4 are not rendered (e.g. blank lines between blocks)
  const laidOut = [false, true, false, true, false, true, true, true];
  const anchors: Anchor[] = [
    { line: 3, top: 100 },
    { line: 5, top: 300 },
  ];
  const map = buildLineMap(anchors, 6, 400, laidOut);
  const bare = buildLineMap(anchors, 6, 400);

  test("landing on a line with no height falls back to the previous real line", () => {
    expect(lineAt(bare, 50, false)).toBe(2);
    expect(lineAt(map, 50, false)).toBe(1);
    expect(lineAt(bare, 200, false)).toBe(4);
    expect(lineAt(map, 200, false)).toBe(3);
  });

  test("landing on a line that does have height leaves it alone", () => {
    expect(lineAt(map, 100, false)).toBe(3);
    expect(lineAt(map, 300, false)).toBe(5);
  });

  test("atEnd is not narrowed (`G` is the end of the document; nvim's own `G` goes to a trailing blank line)", () => {
    const trailing = buildLineMap(anchors, 6, 400, [false, true, true, true, true, true, false]);
    expect(lineAt(trailing, 350, true)).toBe(6);
  });

  test("with nothing found going back, the interpolated value stands", () => {
    const none = buildLineMap(anchors, 6, 400, [false, false, false, false, false, false, false]);
    expect(lineAt(none, 200, false)).toBe(4);
  });
});
