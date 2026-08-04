import { describe, expect, test } from "bun:test";
import { sanitizeBlock, sanitizeLine, truncateToWidth } from "./text.ts";

const ESC = "\x1b";

describe("sanitizeLine", () => {
  test("neutralizes every C0 control and DEL (a newline is flattened into the line too)", () => {
    expect(sanitizeLine(`a${ESC}[31mred${ESC}[0m`)).toBe("a?[31mred?[0m");
    expect(sanitizeLine("a\nb\tc\x7f")).toBe("a?b?c?");
  });

  test("leaves non-ASCII untouched", () => {
    expect(sanitizeLine("café❤️.md")).toBe("café❤️.md");
  });
});

describe("sanitizeBlock", () => {
  test("keeps newlines and tabs while neutralizing other controls (a stack stays readable)", () => {
    expect(sanitizeBlock(`Error: ${ESC}[31mx${ESC}[0m\n  at f\t(a.ts)\r`)).toBe(
      "Error: ?[31mx?[0m\n  at f\t(a.ts)?",
    );
  });
});

describe("truncateToWidth", () => {
  test("the returned width matches the real display width and never exceeds max", () => {
    for (const s of ["❤️README.md", "⚠️a", "ℹ️", "０１２", "👨‍👩‍👧x", "plain.md"]) {
      for (let max = 0; max <= 12; max++) {
        const { text, width } = truncateToWidth(s, max);
        expect(width).toBeLessThanOrEqual(max);
        expect(Bun.stringWidth(text)).toBe(width);
      }
    }
  });

  test("a VS16 emoji is treated as one grapheme (its width is not lost to decomposition)", () => {
    expect(truncateToWidth("❤️", 2)).toEqual({ text: "❤️", width: 2 });
    expect(truncateToWidth("❤️", 1)).toEqual({ text: "", width: 0 });
  });

  test("truncates without splitting a full-width boundary", () => {
    expect(truncateToWidth("０１２", 5)).toEqual({ text: "０１", width: 4 });
    expect(truncateToWidth("abc", 2)).toEqual({ text: "ab", width: 2 });
  });
});
