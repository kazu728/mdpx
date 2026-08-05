import { describe, expect, test } from "bun:test";
import {
  sanitizeTerminalBlock,
  sanitizeTerminalLine,
  truncateToDisplayWidth,
} from "./text.ts";

const ESC = "\x1b";

describe("sanitizeTerminalLine", () => {
  test("neutralizes every C0 control and DEL (a newline is flattened into the line too)", () => {
    expect(sanitizeTerminalLine(`a${ESC}[31mred${ESC}[0m`)).toBe("a?[31mred?[0m");
    expect(sanitizeTerminalLine("a\nb\tc\x7f")).toBe("a?b?c?");
  });

  test("leaves non-ASCII untouched", () => {
    expect(sanitizeTerminalLine("café❤️.md")).toBe("café❤️.md");
  });
});

describe("sanitizeTerminalBlock", () => {
  test("keeps newlines and tabs while neutralizing other controls (a stack stays readable)", () => {
    expect(sanitizeTerminalBlock(`Error: ${ESC}[31mx${ESC}[0m\n  at f\t(a.ts)\r`)).toBe(
      "Error: ?[31mx?[0m\n  at f\t(a.ts)?",
    );
  });
});

describe("truncateToDisplayWidth", () => {
  test("the returned width matches the real display width and never exceeds max", () => {
    for (const s of ["❤️README.md", "⚠️a", "ℹ️", "０１２", "👨‍👩‍👧x", "plain.md"]) {
      for (let max = 0; max <= 12; max++) {
        const { text, displayWidth } = truncateToDisplayWidth(s, max);
        expect(displayWidth).toBeLessThanOrEqual(max);
        expect(Bun.stringWidth(text)).toBe(displayWidth);
      }
    }
  });

  test("a VS16 emoji is treated as one grapheme (its width is not lost to decomposition)", () => {
    expect(truncateToDisplayWidth("❤️", 2)).toEqual({ text: "❤️", displayWidth: 2 });
    expect(truncateToDisplayWidth("❤️", 1)).toEqual({ text: "", displayWidth: 0 });
  });

  test("truncates without splitting a full-width boundary", () => {
    expect(truncateToDisplayWidth("０１２", 5)).toEqual({ text: "０１", displayWidth: 4 });
    expect(truncateToDisplayWidth("abc", 2)).toEqual({ text: "ab", displayWidth: 2 });
  });
});
