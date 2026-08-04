// Slow, real nvim (§7). Starts a headless nvim and round-trips through the production nvim.ts.
//   Run with bun run test:integration (kept apart from the units in bun test src/).
// What is under test is the production code itself: jumps go through sendCursor and discovery
// through NvimCursor (rebuilding the luaeval expression or the glob here would go green while the
// real expression and discovery are never tested).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { NvimCursor, listSockets, sendCursor, socketPid } from "../src/nvim.ts";

const nvimPath = Bun.which("nvim");
if (!nvimPath) {
  // A skip exits 0 and goes unnoticed, so always state the reason
  process.stderr.write("skipping the nvim integration tests because nvim was not found\n");
}

// A macOS unix socket path past sun_path (104 bytes) is **silently truncated**, so a
// differently-named socket resolves to the same path and connects to the wrong one. $TMPDIR
// (/var/folders/…) is too long for nvim to create a socket under, so the test working directory goes
// directly under /tmp.
const SHORT_TMP = "/tmp";

/** Cap for tests that poll. They start nvim and round-trip repeatedly, so the 5s default falls short under load. */
const POLL_TEST_TIMEOUT_MS = 30000;

const LINES = 10;
const DOC = Array.from({ length: LINES }, (_, i) => `line ${i + 1}`).join("\n") + "\n";

let root: string;
let opened: string;
let mdPath: string;

// **The server is restarted per test.** A headless nvim that enters a state requiring input (a
// hit-enter prompt for a message, say) reads stdin, nobody presses anything, and it exits 1 with
// "Error reading input" (measured: reused across the suite it dies around the tenth test; this is not
// a signal). Sharing one process lets a message left by one test turn a later one into an unrelated
// "the cursor did not move" failure.
let server: ReturnType<typeof Bun.spawn> | null = null;
let socket: string;

/**
 * The test-only query channel (not a production path), used solely to read nvim's state.
 * The timeout is needed for the same reason as in production sendCursor (--remote-expr never returns
 * against a server waiting for input).
 */
async function query(vimExpr: string): Promise<string> {
  const p = Bun.spawn(["nvim", "--server", socket, "--remote-expr", vimExpr], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  const timer = setTimeout(() => {
    try {
      p.kill();
    } catch {
      // already exited
    }
  }, 2000);
  try {
    const out = await new Response(p.stdout).text();
    await p.exited;
    return out.trim();
  } finally {
    clearTimeout(timer);
  }
}

/** Never misread an empty reply (a vanished server or a failed client launch) as "the cursor is on line 0". */
async function cursorLine(): Promise<number> {
  const out = await query('line(".")');
  if (out === "") throw new Error(`nvim is not responding (server exit=${server?.exitCode})`);
  return Number(out);
}

/** The window's top line. Used to check that the display, not just the cursor, lines up (§4.9). */
async function topLine(): Promise<number> {
  const out = await query('line("w0")');
  if (out === "") throw new Error(`nvim is not responding (server exit=${server?.exitCode})`);
  return Number(out);
}

/**
 * Wait for NvimCursor's send to land. This is the one place that does not poll, because a sending
 * --remote-expr running at the same time as a reading one makes the headless nvim stop replying
 * (measured). mdpx itself keeps in-flight sends to one, so this concurrency exists only in tests.
 * The margin is generous against the 100ms debounce plus one round trip (14–16ms measured).
 */
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
    // **nvim opens it through a symlink while mdpx sends the real path.** mdpx's path is already
    // realpath'd by main's resolveMdPath, so the design has to put both sides through realpath to
    // agree. Rather than rely on an OS-specific fact (macOS's /tmp → /private/tmp), the symlink is
    // created here and checked directly
    opened = join(root, "link.md");
    await symlink(real, opened);
    mdPath = realpathSync(real);
  });

  beforeEach(async () => {
    // Instead of --listen, point XDG_RUNTIME_DIR at a directory and **let nvim create the socket with
    // its default name**, so discovery (scanning for nvim.<pid>.0 and checking pid liveness) is
    // verified against the production layout.
    // --clean detaches it from the developer's init.lua, and -n suppresses the swapfile
    const runDir = await mkdtemp(join(root, "run-"));
    process.env.XDG_RUNTIME_DIR = runDir; // aim NvimCursor's default-location discovery here
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
    expect(await sendCursor(socket, mdPath, 3)).toBe("ok");
    expect(await cursorLine()).toBe(3);
  });

  // set_cursor alone never scrolls when the destination is on screen (the document is 10 lines and
  // the window over 20, so it always is, leaving w0 at 1). Where it shows up in nvim relative to
  // mdpx's top edge would be undetermined, so topline is set too. --clean leaves scrolloff at 0, so
  // the target line becomes the top line exactly
  test("the target line lands at the top of the window (moving the cursor alone does not line them up)", async () => {
    expect(await sendCursor(socket, mdPath, 5)).toBe("ok");
    expect(await topLine()).toBe(5);
    expect(await cursorLine()).toBe(5);
  });

  test("an out-of-range line clamps to the end of the buffer (surviving an nvim-side edit that shortened it)", async () => {
    expect(await sendCursor(socket, mdPath, 9999)).toBe("ok");
    expect(await cursorLine()).toBe(LINES);
  });

  test("a line of 0 or less clamps to the top", async () => {
    expect(await sendCursor(socket, mdPath, 5)).toBe("ok");
    expect(await sendCursor(socket, mdPath, 0)).toBe("ok");
    expect(await cursorLine()).toBe(1);
  });

  test("a session with a different file open is left alone (nobuf)", async () => {
    await sendCursor(socket, mdPath, 5);
    expect(await sendCursor(socket, "/nonexistent/other.md", 2)).toBe("nobuf");
    expect(await cursorLine()).toBe(5);
  });

  test("a current window not in normal mode is skipped, and following resumes back in normal (busy)", async () => {
    await sendCursor(socket, mdPath, 5);
    await query('nvim_input("i")');
    await waitFor("insert mode", async () => (await query("mode()")) === "i");
    expect(await sendCursor(socket, mdPath, 8)).toBe("busy");
    expect(await cursorLine()).toBe(5);

    await query('nvim_input("\\<Esc>")');
    await waitFor("normal mode", async () => (await query("mode()")) === "n");
    expect(await sendCursor(socket, mdPath, 7)).toBe("ok");
    expect(await cursorLine()).toBe(7);
  }, POLL_TEST_TIMEOUT_MS);

  test("a dead socket is failed (degrading to a silent no-op)", async () => {
    expect(await sendCursor(join(root, "dead"), mdPath, 3)).toBe("failed");
  });

  test("an already-aborted signal means no spawn", async () => {
    await sendCursor(socket, mdPath, 4);
    const aborter = new AbortController();
    aborter.abort();
    expect(await sendCursor(socket, mdPath, 2, aborter.signal)).toBe("failed");
    expect(await cursorLine()).toBe(4);
  });

  test("aborting mid-flight kills the child process so nothing lands (the shutdown path)", async () => {
    await sendCursor(socket, mdPath, 4);
    const aborter = new AbortController();
    const inFlight = sendCursor(socket, mdPath, 2, aborter.signal);
    // Let the spawn happen, then interrupt before the round trip (14–16ms measured) finishes
    await Bun.sleep(2);
    aborter.abort();
    expect(await inFlight).toBe("failed");
    expect(await cursorLine()).toBe(4);
  });

  test("NvimCursor finds the socket through default-location discovery and sends", async () => {
    await sendCursor(socket, mdPath, 1);
    const cursor = new NvimCursor(mdPath, { mode: "auto" });
    try {
      cursor.send(6);
      await settle();
      expect(await cursorLine()).toBe(6);
    } finally {
      cursor.close();
    }
  });

  test("back-to-back sends deliver only the newest line (debounce and coalescing)", async () => {
    await sendCursor(socket, mdPath, 1);
    // "It settles on the newest line" alone would go green even if 2→3→4→9 were all delivered.
    // Check that the three in between were never sent, via how often CursorMoved fired
    await query("nvim_command('let g:moves = 0 | autocmd CursorMoved * let g:moves = g:moves + 1')");
    const cursor = new NvimCursor(mdPath, { mode: "auto" });
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
    await sendCursor(socket, mdPath, 1);
    await query("nvim_command('let g:moves = 0 | autocmd CursorMoved * let g:moves = g:moves + 1')");
    const cursor = new NvimCursor(mdPath, { mode: "auto" });
    try {
      cursor.send(2);
      // Resume the key repeat while the debounce (100ms) has fired and the send is **in progress**.
      // An implementation that consumed a mid-flight line on the spot would start the next send every
      // time one finished, bypassing the debounce (extending this wait past the send's completion
      // would never enter that state and would miss the bypass)
      await Bun.sleep(103);
      for (let i = 0; i < 150; i++) {
        cursor.send((i % 8) + 2);
        await Bun.sleep(4);
      }
      await Bun.sleep(900);
      // One before the burst plus one after the settle is enough. A bypassing implementation moves 55 times (measured)
      expect(Number(await query("get(g:, 'moves', -1)"))).toBeLessThanOrEqual(3);
    } finally {
      cursor.close();
    }
  }, POLL_TEST_TIMEOUT_MS);

  test("a session that is not the target is skipped for the next candidate (the nobuf fallback)", async () => {
    const runDir = process.env.XDG_RUNTIME_DIR!;
    const other = join(root, "other.md");
    await writeFile(other, "x\n");
    // Put a decoy with a different file open somewhere the search order **necessarily reaches first**
    // (the subdirectory "aa"). That is one level down, matching the default macOS layout
    // ($TMPDIR/nvim.$USER/<random>/nvim.<pid>.0), so listSockets' subdirectory branch runs here too
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
      await sendCursor(socket, mdPath, 1);
      const cursor = new NvimCursor(mdPath, { mode: "auto" });
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

  test("MDPX_NVIM=off sends nothing", async () => {
    await sendCursor(socket, mdPath, 4);
    const cursor = new NvimCursor(mdPath, { mode: "off" });
    try {
      cursor.send(9);
      await settle();
      expect(await cursorLine()).toBe(4);
    } finally {
      cursor.close();
    }
  });

  test("the queued line is dropped after close (no stray send on exit)", async () => {
    await sendCursor(socket, mdPath, 4);
    const cursor = new NvimCursor(mdPath, { mode: "auto" });
    cursor.send(9);
    cursor.close();
    cursor.send(7);
    await settle();
    expect(await cursorLine()).toBe(4);
  });
});
