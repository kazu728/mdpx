import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  jumpExpr,
  listSockets,
  parseJumpResult,
  parseNvimEnv,
  socketPathFits,
  socketPid,
  type JumpResult,
} from "./nvim.ts";

describe("parseNvimEnv", () => {
  test("unset and empty mean auto-discovery", () => {
    expect(parseNvimEnv(undefined)).toEqual({ mode: "auto" });
    expect(parseNvimEnv("")).toEqual({ mode: "auto" });
    expect(parseNvimEnv("   ")).toEqual({ mode: "auto" });
  });

  test("0 / off disable it with no warning (an explicit choice is simply obeyed)", () => {
    expect(parseNvimEnv("0")).toEqual({ mode: "off" });
    expect(parseNvimEnv("off")).toEqual({ mode: "off" });
  });

  test("a path pins that socket", () => {
    expect(parseNvimEnv("/tmp/nvim.sock")).toEqual({ mode: "socket", path: "/tmp/nvim.sock" });
  });

  test("a path of 104 bytes or more is disabled with a stated reason", () => {
    const long = "/tmp/" + "x".repeat(120);
    const result = parseNvimEnv(long);
    expect(result.mode).toBe("off");
    expect(result.mode === "off" && result.warning).toContain("104");
  });
});

describe("socketPathFits", () => {
  test("the boundary is 104 bytes (sun_path on macOS)", () => {
    const path103Bytes = "/" + "a".repeat(102);
    const path104Bytes = "/" + "a".repeat(103);
    expect(Buffer.byteLength(path103Bytes)).toBe(103);
    expect(Buffer.byteLength(path104Bytes)).toBe(104);
    expect(socketPathFits(path103Bytes)).toBe(true);
    expect(socketPathFits(path104Bytes)).toBe(false);
  });

  test("multi-byte characters are counted in bytes", () => {
    const path103Bytes = "/" + "☃".repeat(34);
    const path106Bytes = "/" + "☃".repeat(35);
    expect(Buffer.byteLength(path103Bytes)).toBe(103);
    expect(Buffer.byteLength(path106Bytes)).toBe(106);
    expect(socketPathFits(path103Bytes)).toBe(true);
    expect(socketPathFits(path106Bytes)).toBe(false);
  });
});

describe("socketPid", () => {
  const cases: [string, number | null][] = [
    ["nvim.85294.0", 85294],
    ["nvim.1.0", 1],
    ["nvim.85294.1", 85294],
    ["nvim.sock", null],
    ["nvim.0.0", null],
    ["nvim.-5.0", null],
    ["nvim.85294", null],
    ["notnvim.85294.0", null],
    ["", null],
  ];
  for (const [name, expected] of cases) {
    test(`${JSON.stringify(name)} → ${expected}`, () => {
      expect(socketPid(name)).toBe(expected);
    });
  }
});

describe("listSockets", () => {
  const CURRENT_PROCESS_PID = process.pid;
  const PID_ABOVE_LINUX_MAXIMUM = 2 ** 22 + 1;
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "mdpx-sock-"));
    await writeFile(join(root, `nvim.${CURRENT_PROCESS_PID}.0`), "");
    await writeFile(join(root, `nvim.${PID_ABOVE_LINUX_MAXIMUM}.0`), "");
    await writeFile(join(root, "other.sock"), "");
    for (const sub of ["zz", "aa"]) {
      await mkdir(join(root, sub));
      await writeFile(join(root, sub, `nvim.${CURRENT_PROCESS_PID}.0`), "");
      await writeFile(join(root, sub, `nvim.${PID_ABOVE_LINUX_MAXIMUM}.0`), "");
    }
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("picks up both the root and the subdirectories, returned in ascending path order", async () => {
    expect(await listSockets(root)).toEqual([
      join(root, "aa", `nvim.${CURRENT_PROCESS_PID}.0`),
      join(root, `nvim.${CURRENT_PROCESS_PID}.0`),
      join(root, "zz", `nvim.${CURRENT_PROCESS_PID}.0`),
    ]);
  });

  test("drops dead pids and names that are not nvim sockets", async () => {
    const found = await listSockets(root);
    expect(found.some((p) => p.includes(String(PID_ABOVE_LINUX_MAXIMUM)))).toBe(false);
    expect(found.some((p) => p.endsWith("other.sock"))).toBe(false);
  });

  test("no socket directory means empty (nvim has never been started)", async () => {
    expect(await listSockets(join(root, "missing"))).toEqual([]);
  });
});

describe("parseJumpResult", () => {
  const cases: [string, JumpResult][] = [
    ["moved", "moved"],
    ["moved\n", "moved"],
    ["editing", "editing"],
    ["buffer-missing", "buffer-missing"],
    ["window-missing", "window-missing"],
    ["", "failed"],
    ["0", "failed"],
    ["E5108: Error executing lua", "failed"],
  ];
  for (const [stdout, expected] of cases) {
    test(`${JSON.stringify(stdout)} → ${expected}`, () => {
      expect(parseJumpResult(stdout)).toBe(expected);
    });
  }
});

describe("jumpExpr", () => {
  test("the path and line go through _A (never string-concatenated into the lua chunk)", () => {
    const expr = jumpExpr("/tmp/a.md", 42);
    expect(expr).toMatch(/^luaeval\('.*', \['\/tmp\/a\.md', 42\]\)$/s);
    expect(expr).toContain("winrestview");
  });

  test("aligns topline with the target line, not just the cursor", () => {
    const expr = jumpExpr("/tmp/a.md", 42);
    expect(expr).toContain("topline = line");
    expect(expr).toContain("lnum = line");
  });

  test("leaves scrolloff alone", () => {
    expect(jumpExpr("/tmp/a.md", 42)).not.toContain("scrolloff");
  });

  test("doubles a single quote in the path (a vimscript string literal)", () => {
    expect(jumpExpr("/tmp/it's.md", 1)).toContain("'/tmp/it''s.md'");
  });

  test("the lua chunk itself contains no single quote (never colliding with vimscript's quoting)", () => {
    const chunk = /^luaeval\('(.*)', \[/s.exec(jumpExpr("/tmp/a.md", 1))![1]!;
    expect(chunk).not.toContain("'");
  });

  test("the line number is rounded to an integer of at least 1 (no non-number in the expression)", () => {
    expect(jumpExpr("/a", 3.7)).toContain("', 3]");
    expect(jumpExpr("/a", 0)).toContain("', 1]");
    expect(jumpExpr("/a", -5)).toContain("', 1]");
    expect(jumpExpr("/a", NaN)).toContain("', 1]");
  });

  test("the mode guard rejects anything but normal, by exact match", () => {
    expect(jumpExpr("/a", 1)).toContain('nvim_get_mode().mode ~= "n"');
  });
});
