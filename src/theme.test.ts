import { describe, expect, test } from "bun:test";
import { pickTheme } from "./theme.ts";

describe("pickTheme", () => {
  test("MDV_THEME=light/dark wins over the system verdict", () => {
    expect(pickTheme("dark", false)).toBe("dark");
    expect(pickTheme("light", true)).toBe("light");
  });

  test("uppercase and surrounding whitespace are accepted", () => {
    expect(pickTheme(" DARK ", false)).toBe("dark");
    expect(pickTheme("Light", true)).toBe("light");
  });

  test("unset, empty, and unknown values follow the system verdict", () => {
    expect(pickTheme(undefined, true)).toBe("dark");
    expect(pickTheme(undefined, false)).toBe("light");
    expect(pickTheme("", true)).toBe("dark");
    expect(pickTheme("solarized", false)).toBe("light");
  });
});
