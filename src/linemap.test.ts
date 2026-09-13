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

  test("virtual anchors close head/tail (also with no anchors)", () => {
    expect(build([{ sourceLine: 3, topCssPx: 100 }])).toEqual([
      { sourceLine: 1, topCssPx: 0 },
      { sourceLine: 3, topCssPx: 100 },
      { sourceLine: 7, topCssPx: 400 },
    ]);
    expect(build([])).toEqual([
      { sourceLine: 1, topCssPx: 0 },
      { sourceLine: 7, topCssPx: 400 },
    ]);
  });

  test("drops backwards/out-of-range/duplicate/NaN anchors", () => {
    expect(build([{ sourceLine: 3, topCssPx: 100 }, { sourceLine: 2, topCssPx: 150 }, { sourceLine: 5, topCssPx: 200 }]).map((a) => a.sourceLine)).toEqual([1, 3, 5, 7]);
    expect(build([{ sourceLine: 3, topCssPx: 100 }, { sourceLine: 4, topCssPx: 500 }]).map((a) => a.sourceLine)).toEqual([1, 3, 7]);
    expect(build([{ sourceLine: 3, topCssPx: 100 }, { sourceLine: 3, topCssPx: 110 }, { sourceLine: 4, topCssPx: 130 }]).map((a) => a.topCssPx)).toEqual([0, 100, 130, 400]);
    const out = build([
      { sourceLine: NaN, topCssPx: 50 },
      { sourceLine: 3, topCssPx: Infinity },
      { sourceLine: 4, topCssPx: 200 },
    ]);
    expect(out.map((anchor) => anchor.sourceLine)).toEqual([1, 4, 7]);
  });

  test("no tail anchor when height equals last anchor", () => {
    expect(buildLineMap([{ sourceLine: 3, topCssPx: 400 }], 6, 400, new Set()).anchors).toEqual([
      { sourceLine: 1, topCssPx: 0 },
      { sourceLine: 3, topCssPx: 400 },
    ]);
  });

  test("line and top come out strictly increasing", () => {
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
    ["top is line 1", 0, 1],
    ["mid-block interpolates", 200, 4],
    ["bottom clamps to count", 400, 6],
  ];
  for (const [name, viewportTopCssPx, expected] of cases) {
    test(name, () => {
      expect(sourceLineAt(map, viewportTopCssPx, false)).toBe(expected);
    });
  }

  test("jumpToEnd gives last line", () => {
    expect(sourceLineAt(map, 0, true)).toBe(6);
    expect(sourceLineAt(map, 350, true)).toBe(6);
  });

  test("clamps past count (also with only virtual anchors)", () => {
    const m = buildLineMap([{ sourceLine: 99, topCssPx: 100 }], 4, 400, new Set());
    expect(sourceLineAt(m, 200, false)).toBe(4);
    const v = buildLineMap([], 10, 200, new Set());
    expect(sourceLineAt(v, 0, false)).toBe(1);
    expect(sourceLineAt(v, 200, false)).toBe(10);
  });
});

describe("sourceLineAt's laid-out-line snapping", () => {
  const laidOutSourceLines = new Set([1, 3, 5, 6, 7]);
  const anchors: Anchor[] = [
    { sourceLine: 3, topCssPx: 100 },
    { sourceLine: 5, topCssPx: 300 },
  ];
  const map = buildLineMap(anchors, 6, 400, laidOutSourceLines);

  test("no-height lines fall back to previous real line", () => {
    expect(sourceLineAt(map, 50, false)).toBe(1);
    expect(sourceLineAt(map, 200, false)).toBe(3);
  });

  test("laid-out lines pass through; jumpToEnd not narrowed", () => {
    expect(sourceLineAt(map, 100, false)).toBe(3);
    expect(sourceLineAt(map, 300, false)).toBe(5);
    const trailing = buildLineMap(anchors, 6, 400, new Set([1, 2, 3, 4, 5]));
    expect(sourceLineAt(trailing, 350, true)).toBe(6);
  });
});
