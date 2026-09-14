import { describe, expect, test } from "bun:test";
import { countSourceLines } from "./sourcemap.ts";

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
