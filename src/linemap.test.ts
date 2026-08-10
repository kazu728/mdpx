import { describe, expect, test } from "bun:test";
import { buildLineMap, countSourceLines, sourceLineAt, type Anchor } from "./linemap.ts";

describe("countSourceLines", () => {
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
      expect(countSourceLines(src)).toBe(expected);
    });
  }
});

describe("buildLineMap", () => {
  const build = (anchors: Anchor[], sourceLineCount = 6, documentHeightCssPx = 400) =>
    buildLineMap(anchors, sourceLineCount, documentHeightCssPx, new Set()).anchors;

  test("closed by the virtual anchors {1,0} at the head and {sourceLineCount+1, documentHeightCssPx} at the tail", () => {
    expect(build([{ sourceLine: 3, topCssPx: 100 }])).toEqual([
      { sourceLine: 1, topCssPx: 0 },
      { sourceLine: 3, topCssPx: 100 },
      { sourceLine: 7, topCssPx: 400 },
    ]);
  });

  test("holds up on the two ends alone when there is not a single anchor", () => {
    expect(build([])).toEqual([
      { sourceLine: 1, topCssPx: 0 },
      { sourceLine: 7, topCssPx: 400 },
    ]);
  });

  test("drops anchors whose line goes backwards (elements like footnotes, where document order diverges from source order)", () => {
    const out = build([
      { sourceLine: 3, topCssPx: 100 },
      { sourceLine: 2, topCssPx: 150 },
      { sourceLine: 5, topCssPx: 200 },
    ]);
    expect(out.map((anchor) => anchor.sourceLine)).toEqual([1, 3, 5, 7]);
  });

  test("drops duplicates pointing at the same line (a list_item and the paragraph inside it)", () => {
    const out = build([
      { sourceLine: 3, topCssPx: 100 },
      { sourceLine: 3, topCssPx: 110 },
      { sourceLine: 4, topCssPx: 130 },
    ]);
    expect(out.map((anchor) => anchor.topCssPx)).toEqual([0, 100, 130, 400]);
  });

  test("drops anchors whose top goes backwards", () => {
    const out = build([
      { sourceLine: 3, topCssPx: 200 },
      { sourceLine: 4, topCssPx: 150 },
      { sourceLine: 5, topCssPx: 250 },
    ]);
    expect(out.map((anchor) => anchor.sourceLine)).toEqual([1, 3, 5, 7]);
  });

  test("drops anchors whose top exceeds documentHeightCssPx", () => {
    const out = build([
      { sourceLine: 3, topCssPx: 100 },
      { sourceLine: 4, topCssPx: 500 },
    ]);
    expect(out.map((anchor) => anchor.sourceLine)).toEqual([1, 3, 7]);
  });

  test("a head anchor (line 1, top 0) is dropped as a duplicate of the virtual one", () => {
    const out = build([
      { sourceLine: 1, topCssPx: 0 },
      { sourceLine: 3, topCssPx: 100 },
    ]);
    expect(out.map((anchor) => anchor.sourceLine)).toEqual([1, 3, 7]);
  });

  test("drops NaN and Infinity", () => {
    const out = build([
      { sourceLine: NaN, topCssPx: 50 },
      { sourceLine: 3, topCssPx: Infinity },
      { sourceLine: 4, topCssPx: 200 },
    ]);
    expect(out.map((anchor) => anchor.sourceLine)).toEqual([1, 4, 7]);
  });

  test("no tail anchor is added when documentHeightCssPx equals the last anchor", () => {
    const out = buildLineMap([{ sourceLine: 3, topCssPx: 400 }], 6, 400, new Set()).anchors;
    expect(out).toEqual([
      { sourceLine: 1, topCssPx: 0 },
      { sourceLine: 3, topCssPx: 400 },
    ]);
  });

  test("both line and top come out strictly increasing", () => {
    const out = build([
      { sourceLine: 5, topCssPx: 300 },
      { sourceLine: 2, topCssPx: 50 },
      { sourceLine: 5, topCssPx: 320 },
      { sourceLine: 3, topCssPx: 100 },
      { sourceLine: 9, topCssPx: 380 },
    ]);
    for (let i = 1; i < out.length; i++) {
      expect(out[i]!.sourceLine).toBeGreaterThan(out[i - 1]!.sourceLine);
      expect(out[i]!.topCssPx).toBeGreaterThan(out[i - 1]!.topCssPx);
    }
  });
});

describe("sourceLineAt", () => {
  const map = buildLineMap(
    [
      { sourceLine: 3, topCssPx: 100 },
      { sourceLine: 5, topCssPx: 300 },
    ],
    6,
    400,
    new Set(),
  );

  const cases: [string, number, number][] = [
    ["the top is line 1 (no special case needed)", 0, 1],
    ["inside a block it interpolates proportionally to px", 50, 2],
    ["an anchor position is exact", 100, 3],
    ["it keeps advancing through a long block", 200, 4],
    ["the next anchor position", 300, 5],
    ["partway through the final block", 350, 6],
    ["the bottom of the document clamps to sourceLineCount", 400, 6],
    ["past the bottom is sourceLineCount too", 10_000, 6],
    ["past the top is line 1", -50, 1],
  ];
  for (const [name, viewportTopCssPx, expected] of cases) {
    test(name, () => {
      expect(sourceLineAt(map, viewportTopCssPx, false)).toBe(expected);
    });
  }

  test("jumpToEnd gives the document's last line rather than the interpolated value", () => {
    expect(sourceLineAt(map, 0, true)).toBe(6);
    expect(sourceLineAt(map, 350, true)).toBe(6);
  });

  test("clamps even when an anchor points past sourceLineCount", () => {
    const m = buildLineMap([{ sourceLine: 99, topCssPx: 100 }], 4, 400, new Set());
    expect(sourceLineAt(m, 200, false)).toBe(4);
  });

  test("returns a line across the whole range with only the two virtual anchors", () => {
    const m = buildLineMap([], 10, 200, new Set());
    expect(sourceLineAt(m, 0, false)).toBe(1);
    expect(sourceLineAt(m, 100, false)).toBe(6);
    expect(sourceLineAt(m, 200, false)).toBe(10);
  });
});

describe("sourceLineAt's laid-out-line snapping", () => {
  const laidOutSourceLines = new Set([1, 3, 5, 6, 7]);
  const anchors: Anchor[] = [
    { sourceLine: 3, topCssPx: 100 },
    { sourceLine: 5, topCssPx: 300 },
  ];
  const map = buildLineMap(anchors, 6, 400, laidOutSourceLines);

  // Without the set, the same positions interpolate to 2 and 4 (fixed in the sourceLineAt suite).
  test("landing on a line with no height falls back to the previous real line", () => {
    expect(sourceLineAt(map, 50, false)).toBe(1);
    expect(sourceLineAt(map, 200, false)).toBe(3);
  });

  test("landing on a line that does have height leaves it alone", () => {
    expect(sourceLineAt(map, 100, false)).toBe(3);
    expect(sourceLineAt(map, 300, false)).toBe(5);
  });

  test("jumpToEnd is not narrowed, matching nvim's `G` on a trailing blank line", () => {
    const trailing = buildLineMap(anchors, 6, 400, new Set([1, 2, 3, 4, 5]));
    expect(sourceLineAt(trailing, 350, true)).toBe(6);
  });
});
