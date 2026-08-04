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

  // An over-long path is silently truncated by sun_path and can connect to a differently-named socket (reproduced)
  test("a path of 104 bytes or more is disabled with a stated reason", () => {
    const long = "/tmp/" + "x".repeat(120);
    const result = parseNvimEnv(long);
    expect(result.mode).toBe("off");
    expect(result.mode === "off" && result.warning).toContain("104");
  });
});

describe("socketPathFits", () => {
  test("the boundary is 104 bytes (sun_path on macOS)", () => {
    expect(socketPathFits("/" + "a".repeat(102))).toBe(true); // 103 bytes
    expect(socketPathFits("/" + "a".repeat(103))).toBe(false); // 104 bytes
  });

  test("multi-byte characters are counted in bytes", () => {
    expect(socketPathFits("/" + "☃".repeat(34))).toBe(true); // 1 + 102 bytes
    expect(socketPathFits("/" + "☃".repeat(35))).toBe(false); // 1 + 105 bytes
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

// There are two default socket layouts (§4.9). The one actually taken on macOS is **the subdirectory
// form** (XDG_RUNTIME_DIR unset → $TMPDIR/nvim.$USER/<random>/nvim.<pid>.0), so the layout the
// integration tests set up directly under the root never exercises the production branch. Both are
// pinned down here.
describe("listSockets", () => {
  const ALIVE = process.pid; // our own process is definitely alive
  const DEAD = 4_194_305; // above Linux's pid_max ceiling (2^22), so it can never be allocated
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "mdpx-sock-"));
    await writeFile(join(root, `nvim.${ALIVE}.0`), ""); // the layout when XDG is set
    await writeFile(join(root, `nvim.${DEAD}.0`), ""); // a stale socket from a dead nvim
    await writeFile(join(root, "other.sock"), ""); // not an nvim socket
    for (const sub of ["zz", "aa"]) {
      await mkdir(join(root, sub));
      await writeFile(join(root, sub, `nvim.${ALIVE}.0`), ""); // the default (macOS) layout
      await writeFile(join(root, sub, `nvim.${DEAD}.0`), "");
    }
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("picks up both the root and the subdirectories, returned in ascending path order", async () => {
    expect(await listSockets(root)).toEqual([
      join(root, "aa", `nvim.${ALIVE}.0`),
      join(root, `nvim.${ALIVE}.0`),
      join(root, "zz", `nvim.${ALIVE}.0`),
    ]);
  });

  test("drops dead pids and names that are not nvim sockets", async () => {
    const found = await listSockets(root);
    expect(found.some((p) => p.includes(String(DEAD)))).toBe(false);
    expect(found.some((p) => p.endsWith("other.sock"))).toBe(false);
  });

  test("no socket directory means empty (nvim has never been started)", async () => {
    expect(await listSockets(join(root, "missing"))).toEqual([]);
  });
});

describe("parseJumpResult", () => {
  const cases: [string, JumpResult][] = [
    ["ok", "ok"],
    ["ok\n", "ok"],
    ["busy", "busy"],
    ["nobuf", "nobuf"],
    ["nowin", "nowin"],
    ["", "failed"],
    ["0", "failed"], // luaeval returning nil comes out as 0
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

  // set_cursor alone does not scroll when the destination is on screen and centres it when it is far
  // away. Where it shows up in nvim relative to mdpx's top edge would be undetermined, so topline is
  // set too (§4.9)
  test("aligns topline with the target line, not just the cursor", () => {
    const expr = jumpExpr("/tmp/a.md", 42);
    expect(expr).toContain("topline = line");
    expect(expr).toContain("lnum = line");
  });

  // Overriding scrolloff changes nothing: nvim re-clamps as long as the cursor sits on the target
  // line (measured). Overriding it would only add the side effect of a lingering window-local value
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

  // A prefix comparison would treat "no" (operator-pending) as normal and move the cursor mid-`d`
  test("the mode guard rejects anything but normal, by exact match", () => {
    expect(jumpExpr("/a", 1)).toContain('nvim_get_mode().mode ~= "n"');
  });
});
