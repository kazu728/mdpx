import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  jumpExpr,
  listSockets,
  parseJumpResult,
  socketPathFits,
  socketPid,
  type JumpResult,
} from "./nvim.ts";

describe("socketPathFits", () => {
  test("104-byte boundary counted in bytes (ascii + multibyte)", () => {
    expect(Buffer.byteLength("/" + "a".repeat(102))).toBe(103);
    expect(socketPathFits("/" + "a".repeat(102))).toBe(true);
    expect(socketPathFits("/" + "a".repeat(103))).toBe(false);
    expect(Buffer.byteLength("/" + "☃".repeat(34))).toBe(103);
    expect(socketPathFits("/" + "☃".repeat(34))).toBe(true);
    expect(socketPathFits("/" + "☃".repeat(35))).toBe(false);
  });
});

describe("socketPid", () => {
  test("pid names → pid, others → null", () => {
    expect(socketPid("nvim.85294.0")).toBe(85294);
    expect(socketPid("nvim.85294.1")).toBe(85294);
    expect(socketPid("nvim.1.0")).toBe(1);
    for (const n of ["nvim.sock", "nvim.85294", "notnvim.85294.0", "", "nvim.0.0", "nvim.-5.0"])
      expect(socketPid(n)).toBeNull();
  });
});

describe("listSockets", () => {
  const PID = process.pid;
  const DEAD_PID = 2 ** 22 + 1;
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "mdpx-sock-"));
    await writeFile(join(root, `nvim.${PID}.0`), "");
    await writeFile(join(root, `nvim.${DEAD_PID}.0`), "");
    await writeFile(join(root, "other.sock"), "");
    await mkdir(join(root, "sub"));
    await writeFile(join(root, "sub", `nvim.${PID}.0`), "");
    await writeFile(join(root, "sub", `nvim.${DEAD_PID}.0`), "");
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("picks up root + subdir, drops dead pids and non-nvim names", async () => {
    expect(await listSockets(root)).toEqual([
      join(root, `nvim.${PID}.0`),
      join(root, "sub", `nvim.${PID}.0`),
    ]);
    const found = await listSockets(root);
    expect(found.some((p) => p.includes(String(DEAD_PID)))).toBe(false);
    expect(found.some((p) => p.endsWith("other.sock"))).toBe(false);
  });

  test("missing dir means empty", async () => {
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
  test("path and line go through _A with winrestview", () => {
    const expr = jumpExpr("/tmp/a.md", 42);
    expect(expr).toMatch(/^luaeval\('.*', \['\/tmp\/a\.md', 42\]\)$/s);
    expect(expr).toContain("winrestview");
    expect(expr).toContain("topline = line");
  });

  test("doubles single quote in path", () => {
    expect(jumpExpr("/tmp/it's.md", 1)).toContain("'/tmp/it''s.md'");
  });

  test("line rounds to int >= 1", () => {
    expect(jumpExpr("/a", 3.7)).toContain("', 3]");
    expect(jumpExpr("/a", 0)).toContain("', 1]");
    expect(jumpExpr("/a", NaN)).toContain("', 1]");
  });

  test("mode guard is exact normal match", () => {
    expect(jumpExpr("/a", 1)).toContain('nvim_get_mode().mode ~= "n"');
  });
});
