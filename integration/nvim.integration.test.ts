import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { NvimCursor, listSockets, sendCursor, socketPid } from "../src/nvim.ts";

const nvimPath = Bun.which("nvim");
if (!nvimPath) {
  process.stderr.write("skipping the nvim integration tests because nvim was not found\n");
}

// Keep the test root under /tmp; macOS truncates unix socket paths at 104 bytes.
const SHORT_TMP = "/tmp";

// Nvim round trips can exceed Bun's default timeout.
const POLL_TEST_TIMEOUT_MS = 30000;

const NEVER_ABORTED = new AbortController().signal;

const LINES = 10;
const DOC = Array.from({ length: LINES }, (_, i) => `line ${i + 1}`).join("\n") + "\n";

let root: string;
let opened: string;
let mdPath: string;

// Restart the server per test. A prompt that consumes stdin can otherwise make a later cursor
// assertion fail with an unrelated error.
let server: ReturnType<typeof Bun.spawn> | null = null;
let socket: string;

/** Test-only state query with the same timeout behavior as production. */
async function query(vimExpr: string): Promise<string> {
  const p = Bun.spawn(["nvim", "--server", socket, "--remote-expr", vimExpr], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  const timer = setTimeout(() => {
    try {
      p.kill();
    } catch {}
  }, 2000);
  try {
    const out = await new Response(p.stdout).text();
    await p.exited;
    return out.trim();
  } finally {
    clearTimeout(timer);
  }
}

async function cursorLine(): Promise<number> {
  const out = await query('line(".")');
  if (out === "") throw new Error(`nvim is not responding (server exit=${server?.exitCode})`);
  return Number(out);
}

async function topLine(): Promise<number> {
  const out = await query('line("w0")');
  if (out === "") throw new Error(`nvim is not responding (server exit=${server?.exitCode})`);
  return Number(out);
}

/** Wait past the debounce and one in-flight send. */
const settle = () => Bun.sleep(800);

async function waitFor(label: string, ok: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 60; i++) {
    if (await ok()) return;
    await Bun.sleep(50);
  }
  throw new Error(`timed out waiting for ${label} (server exit=${server?.exitCode})`);
}

describe.skipIf(!nvimPath)("nvim cursor following", () => {
  beforeAll(async () => {
    root = await mkdtemp(join(SHORT_TMP, "mdpx-nvim-"));
    const real = join(root, "doc.md");
    await writeFile(real, DOC);
    // Exercise realpath matching when nvim opens the symlink and mdpx sends the target path.
    opened = join(root, "link.md");
    await symlink(real, opened);
    mdPath = realpathSync(real);
  });

  beforeEach(async () => {
    // Use nvim's default socket layout so discovery follows the production path.
    const runDir = await mkdtemp(join(root, "run-"));
    process.env.XDG_RUNTIME_DIR = runDir;
    server = Bun.spawn(["nvim", "--clean", "-n", "--headless", opened], {
      env: { ...process.env, XDG_RUNTIME_DIR: runDir },
      stdin: "pipe", // "ignore" (= /dev/null) hits EOF immediately and dies the moment input is needed
      stdout: "ignore",
      stderr: "ignore",
    });
    await waitFor("nvim socket", async () => {
      const names = await readdir(runDir).catch(() => [] as string[]);
      const found = names.find((n) => socketPid(n) !== null);
      if (found) socket = join(runDir, found);
      return found !== undefined;
    });
    await waitFor("buffer load", async () => (await query("bufname()")) !== "");
  }, 30000);

  afterEach(async () => {
    server?.kill();
    await server?.exited;
    server = null;
    delete process.env.XDG_RUNTIME_DIR;
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("the cursor moves to the given line", async () => {
    expect(await sendCursor(socket, mdPath, 3, NEVER_ABORTED)).toBe("moved");
    expect(await cursorLine()).toBe(3);
  });

  test("the target line lands at the top of the window (moving the cursor alone does not line them up)", async () => {
    expect(await sendCursor(socket, mdPath, 5, NEVER_ABORTED)).toBe("moved");
    expect(await topLine()).toBe(5);
    expect(await cursorLine()).toBe(5);
  });

  test("an out-of-range line clamps to the end of the buffer (surviving an nvim-side edit that shortened it)", async () => {
    expect(await sendCursor(socket, mdPath, 9999, NEVER_ABORTED)).toBe("moved");
    expect(await cursorLine()).toBe(LINES);
  });

  test("a line of 0 or less clamps to the top", async () => {
    expect(await sendCursor(socket, mdPath, 5, NEVER_ABORTED)).toBe("moved");
    expect(await sendCursor(socket, mdPath, 0, NEVER_ABORTED)).toBe("moved");
    expect(await cursorLine()).toBe(1);
  });

  test("a session with a different file open is left alone", async () => {
    await sendCursor(socket, mdPath, 5, NEVER_ABORTED);
    expect(await sendCursor(socket, "/nonexistent/other.md", 2, NEVER_ABORTED)).toBe("buffer-missing");
    expect(await cursorLine()).toBe(5);
  });

  test("a current window not in normal mode is skipped, and following resumes back in normal", async () => {
    await sendCursor(socket, mdPath, 5, NEVER_ABORTED);
    await query('nvim_input("i")');
    await waitFor("insert mode", async () => (await query("mode()")) === "i");
    expect(await sendCursor(socket, mdPath, 8, NEVER_ABORTED)).toBe("editing");
    expect(await cursorLine()).toBe(5);

    await query('nvim_input("\\<Esc>")');
    await waitFor("normal mode", async () => (await query("mode()")) === "n");
    expect(await sendCursor(socket, mdPath, 7, NEVER_ABORTED)).toBe("moved");
    expect(await cursorLine()).toBe(7);
  }, POLL_TEST_TIMEOUT_MS);

  test("a dead socket is failed (degrading to a silent no-op)", async () => {
    expect(await sendCursor(join(root, "dead"), mdPath, 3, NEVER_ABORTED)).toBe("failed");
  });

  test("an already-aborted signal means no spawn", async () => {
    await sendCursor(socket, mdPath, 4, NEVER_ABORTED);
    const aborter = new AbortController();
    aborter.abort();
    expect(await sendCursor(socket, mdPath, 2, aborter.signal)).toBe("failed");
    expect(await cursorLine()).toBe(4);
  });

  test("aborting mid-flight kills the child process so nothing lands (the shutdown path)", async () => {
    await sendCursor(socket, mdPath, 4, NEVER_ABORTED);
    const aborter = new AbortController();
    const inFlight = sendCursor(socket, mdPath, 2, aborter.signal);
    await Bun.sleep(2);
    aborter.abort();
    expect(await inFlight).toBe("failed");
    expect(await cursorLine()).toBe(4);
  });

  test("NvimCursor finds the socket through default-location discovery and sends", async () => {
    await sendCursor(socket, mdPath, 1, NEVER_ABORTED);
    const cursor = new NvimCursor(mdPath);
    try {
      cursor.send(6);
      await settle();
      expect(await cursorLine()).toBe(6);
    } finally {
      cursor.close();
    }
  });

  test("back-to-back sends deliver only the newest line (debounce and coalescing)", async () => {
    await sendCursor(socket, mdPath, 1, NEVER_ABORTED);
    await query("nvim_command('let g:moves = 0 | autocmd CursorMoved * let g:moves = g:moves + 1')");
    const cursor = new NvimCursor(mdPath);
    try {
      for (const line of [2, 3, 4, 9]) cursor.send(line);
      await settle();
      expect(await cursorLine()).toBe(9);
      expect(await query("get(g:, 'moves', -1)")).toBe("1");
    } finally {
      cursor.close();
    }
  });

  test("a key repeat resuming after a settle still rides the debounce (no send storm)", async () => {
    await sendCursor(socket, mdPath, 1, NEVER_ABORTED);
    await query("nvim_command('let g:moves = 0 | autocmd CursorMoved * let g:moves = g:moves + 1')");
    const cursor = new NvimCursor(mdPath);
    try {
      cursor.send(2);
      // Re-enter during an in-flight send to verify that the next line waits for a new debounce.
      await Bun.sleep(103);
      for (let i = 0; i < 150; i++) {
        cursor.send((i % 8) + 2);
        await Bun.sleep(4);
      }
      await Bun.sleep(900);
      expect(Number(await query("get(g:, 'moves', -1)"))).toBeLessThanOrEqual(3);
    } finally {
      cursor.close();
    }
  }, POLL_TEST_TIMEOUT_MS);

  test("a session that is not the target is skipped for the next candidate", async () => {
    const runDir = process.env.XDG_RUNTIME_DIR!;
    const other = join(root, "other.md");
    await writeFile(other, "x\n");
    // Put a decoy in a subdirectory so discovery exercises the nested layout.
    const decoyDir = join(runDir, "aa");
    await mkdir(decoyDir);
    const decoy = Bun.spawn(["nvim", "--clean", "-n", "--headless", other], {
      env: { ...process.env, XDG_RUNTIME_DIR: decoyDir },
      stdin: "pipe",
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      await waitFor("decoy socket", async () => (await listSockets(runDir)).length === 2);
      expect((await listSockets(runDir))[0]).toContain("/aa/");
      await sendCursor(socket, mdPath, 1, NEVER_ABORTED);
      const cursor = new NvimCursor(mdPath);
      try {
        cursor.send(8);
        await settle();
        expect(await cursorLine()).toBe(8);
      } finally {
        cursor.close();
      }
    } finally {
      decoy.kill();
      await decoy.exited;
    }
  }, POLL_TEST_TIMEOUT_MS);

  test("the queued line is dropped after close (no stray send on exit)", async () => {
    await sendCursor(socket, mdPath, 4, NEVER_ABORTED);
    const cursor = new NvimCursor(mdPath);
    cursor.send(9);
    cursor.close();
    cursor.send(7);
    await settle();
    expect(await cursorLine()).toBe(4);
  });
});
