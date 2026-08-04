#!/usr/bin/env bun
// CLI entry and event wiring (§3). Feeds watch/key/resize into the scheduler and runs the
// actions it hands back through the I/O modules (chrome/term/kitty).

import { realpathSync, statSync, watch, type FSWatcher } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { resolveAssets, type Assets } from "./assets.ts";
import { buildHtml } from "./html.ts";
import { resolveTheme } from "./theme.ts";
import { Chrome, ContentError, parseExecutableEnv, resolveExecutable } from "./chrome.ts";
import { renderFrame } from "./frame.ts";
import { deleteImage, imageId, transmit } from "./kitty.ts";
import { buildLineMap, countLines, lineAt, type Anchor, type LineMap } from "./linemap.ts";
import { NvimCursor, parseNvimEnv } from "./nvim.ts";
import { Scheduler, type Action, type ScrollDelta } from "./scheduler.ts";
import { sanitizeBlock, sanitizeLine } from "./text.ts";
import { Term, parseCellSize, type CellSize } from "./term.ts";
import { CSS_SCALE } from "./viewport.ts";

const CELL_QUERY_MS = 200;
const GRAPHICS_QUERY_MS = 200; // §4.7: reply deadline for the kitty graphics query (paired with the DA sync marker)
const WATCH_DEBOUNCE_MS = 100;
const MAX_CONSECUTIVE_FAILURES = 2; // §4.6: two in a row exits 1
const CHROME_CLOSE_TIMEOUT_MS = 1500; // the terminal is already restored, so a stuck close must not block exit

type ShootAction = Extract<Action, { type: "shoot" }>;

// Errors land on the bare terminal, before alt-screen and after restore, so unfiltered text would
// let CSI/OSC sequences from argv or paths reach it. Every stderr write goes through warn /
// unsupportedTerminalExit below plus shutdown and main().catch, and any string from outside is
// stripped of control characters first (text.sanitizeLine for one-liners, sanitizeBlock for
// multi-line stacks, which keeps newlines).
function warn(msg: string): void {
  process.stderr.write(sanitizeLine(`mdpx: ${msg}`) + "\n");
}

function usageExit(msg: string): never {
  warn(msg);
  process.exit(1);
}

function unsupportedTerminalExit(): never {
  process.stderr.write(
    "mdpx: run this in a terminal that supports kitty graphics (Ghostty/Kitty)\n" +
      'hint: open -na Ghostty --args --command="mdpx <path>"\n' +
      "terminals that do not report cell metrics (some multiplexers) can set MDPX_CELL=<heightPx>,<widthPx>\n",
  );
  process.exit(1);
}

// Resolve the argument to its real path. When opened through a symlink, both the <base> for
// relative images and the watch must point at the real file: the symlink's directory never sees
// the save event, and relative images would resolve against the symlink side.
// If the file vanishes between the check and the resolve (TOCTOU), exit with the §6 one-line
// error rather than a raw stack.
function resolveMdPath(arg: string): string {
  try {
    const resolved = resolve(arg);
    if (statSync(resolved).isFile()) return realpathSync(resolved);
  } catch {
    // Missing, unreadable, or raced away — all fall through to the one-line error below
  }
  usageExit(`file not found: ${arg}`);
}

async function main(): Promise<void> {
  const arg = process.argv[2];
  if (!arg) usageExit("usage: mdpx <file.md>");
  const mdPath = resolveMdPath(arg);
  const mdDir = dirname(mdPath);
  const fileName = basename(mdPath);
  // macOS FSEvents reports names as stored (NFD, real case). Compare as NFC + lowercase so nothing slips through.
  const watchTarget = fileName.normalize("NFC").toLowerCase();

  // Without a TTY on stdin no key (q/j/k) ever arrives and raw mode is unavailable, so reject here
  // too. Checking stdout alone would leave a running viewer that cannot be operated.
  if (!process.stdout.isTTY || !process.stdin.isTTY) unsupportedTerminalExit();

  // MDPX_CELL is the §4.7 last resort (the escape hatch for terminals that pass graphics through
  // but never answer), so silently dropping a malformed value would exit as "unsupported terminal"
  // with the override never taking effect. Warn here, before raw mode turns a bare LF into a staircase.
  const mdpxCell = process.env.MDPX_CELL;
  const cellOverride = parseCellSize(mdpxCell);
  if (mdpxCell && !cellOverride) {
    warn(`ignoring MDPX_CELL (malformed <heightPx>,<widthPx> or out-of-range value): ${mdpxCell}`);
  }

  // MDPX_NVIM is parsed here for the same reason (past raw mode the warning's newline staircases).
  const nvimTarget = parseNvimEnv(process.env.MDPX_NVIM);
  if (nvimTarget.mode === "off" && nvimTarget.warning) warn(nvimTarget.warning);

  // Dropping a bad PUPPETEER_EXECUTABLE_PATH in silence is worse than for the two above: resolution
  // continues to the installed Chromium, so the viewer comes up on a browser the user did not pick.
  const chromeEnv = process.env.PUPPETEER_EXECUTABLE_PATH;
  if (chromeEnv && !parseExecutableEnv(chromeEnv)) {
    warn(`ignoring PUPPETEER_EXECUTABLE_PATH (not an executable file): ${chromeEnv}`);
  }

  const term = new Term();
  term.enableInput();

  const chrome = new Chrome();
  const nvim = new NvimCursor(mdPath, nvimTarget);
  // Line anchors per generation (§4.9). Lookups always use displayGen's map — never resolve a
  // position in the displayed generation against a newer map that has not been promoted yet.
  const lineMaps = new Map<number, LineMap>();
  let dir: string | null = null;
  let watcher: FSWatcher | null = null;
  let debounce: ReturnType<typeof setTimeout> | null = null;
  let scheduler: Scheduler;
  let consecutiveFailures = 0;
  let shuttingDown = false;
  let lastPlacements: number[] = []; // image IDs placed by the previous frame, deleted by the next. frame.ts is pure, so main holds them

  async function shutdown(code: number, message?: string): Promise<never> {
    if (shuttingDown) return new Promise<never>(() => {}); // the earlier shutdown will exit
    shuttingDown = true;
    // process.exit must be reached even if part of the cleanup throws synchronously (§4.6's
    // terminal-restore guarantee). Escaping here would leave a re-entered shutdown pending forever
    // on the shuttingDown guard and hang.
    try {
      if (debounce) clearTimeout(debounce);
      watcher?.close();
      nvim.close(); // drop the pending send and kill any in-flight child process
      term.restore(); // restoring the terminal comes first (synchronous write)
      if (message) process.stderr.write(sanitizeBlock(message));
      await Promise.race([chrome.close(), new Promise((r) => setTimeout(r, CHROME_CLOSE_TIMEOUT_MS))]);
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
    } catch {
      // Swallow cleanup failures; exiting is what matters
    }
    process.exit(code);
  }

  // Wire the exit paths before the geometry is settled and the scheduler exists, so q/Ctrl-C and
  // SIGTERM get out cleanly during startup's Chrome launch (scrolling stays inert until then).
  term.onKey((k) => {
    if (k.type === "quit") void shutdown(0);
  });
  // SIGHUP (terminal closed, parent shell exited) is wired too: registering a listener suppresses
  // the default handling, so leaving it out orphans a process still holding raw stdin, the watcher,
  // and the tmpdir.
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, () => void shutdown(0));
  process.on("uncaughtException", (e) => void shutdown(1, `mdpx: ${e?.stack ?? e}\n`));
  process.on("unhandledRejection", (e) => {
    void shutdown(1, `mdpx: ${e instanceof Error ? e.stack : e}\n`);
  });

  // Cell px resolution (§4.7): explicit MDPX_CELL → CSI 16t → TIOCGWINSZ. Startup and resize both
  // go through resolveCell, keeping the order in one place.
  //
  // Whether to try 16t at all is decided once, here at startup. Chrome has not launched and nothing
  // is being drawn, so silence for CELL_QUERY_MS is good enough evidence that 16t is unsupported.
  // Waiting on a reply that never comes at every resize would delay each redraw on exactly the
  // terminals this fallback exists for. Even once 16t is chosen, the TIOCGWINSZ fallback below stays
  // — one reply lost to load must not drop geometry updates on a terminal that does report pixel sizes.
  const use16t = !cellOverride && (await term.queryCellSize(CELL_QUERY_MS)) !== null;
  const resolveCell = async (): Promise<CellSize | null> =>
    cellOverride ?? (use16t ? await term.queryCellSize(CELL_QUERY_MS) : null) ?? term.queryWinsizeCell();

  // Startup capability check (§4.7): open if the terminal speaks kitty graphics (never branch on
  // terminal name). Auto-detected terminals are judged by a real graphics query reply — that rejects
  // terminals which answer 16t but lack graphics, and lets multiplexers that do not relay 16t
  // (herdr and friends, whose winsize and graphics replies do get through) run unconfigured.
  // An explicit MDPX_CELL counts as the user declaring support and skips the probe (the escape hatch
  // for environments that pass graphics through but never reply; closing it removes the only workaround).
  const cell = await resolveCell();
  if (!cell) {
    term.restore();
    unsupportedTerminalExit();
  }
  if (!cellOverride && !(await term.queryKittyGraphics(GRAPHICS_QUERY_MS))) {
    term.restore();
    unsupportedTerminalExit();
  }

  const theme = resolveTheme();

  // Do the initialization that can fail before alt-screen, so a startup that exits never flashes it
  let assets: Assets;
  try {
    assets = resolveAssets(theme);
    dir = await mkdtemp(join(tmpdir(), "mdpx-"));
  } catch (e) {
    return shutdown(1, `mdpx: ${e instanceof Error ? e.stack : e}\n`);
  }
  try {
    await chrome.launch();
  } catch (e) {
    // Absence is an actionable setup problem; a found binary's launch failure needs its stack for diagnosis.
    const tried = resolveExecutable();
    return shutdown(
      1,
      tried
        ? `mdpx: cannot launch Chrome (${tried}): ${e instanceof Error ? e.stack : e}\n`
        : "mdpx: no Chromium found. Install Google Chrome, or point PUPPETEER_EXECUTABLE_PATH at a Chromium binary\n",
    );
  }
  const htmlPath = join(dir, "view.html");

  scheduler = new Scheduler(term.geometry(cell));

  // Run a Chrome operation with crash tolerance (§4.6). restarted=true marks the retry right after a
  // restart. No exception escapes: failures are counted, Chrome is restarted, and the cap exits
  // (never an unhandled rejection). ContentError (an infinite-loop script and other content-caused
  // failures) is not a Chrome fault, so it is left to the caller.
  async function attempt<T>(fn: (restarted: boolean) => Promise<T>): Promise<T> {
    let restarted = false;
    for (;;) {
      try {
        const r = await fn(restarted);
        consecutiveFailures = 0;
        return r;
      } catch (e) {
        if (e instanceof ContentError) throw e; // a restart fails the same way on the same content; keep the classes apart
        consecutiveFailures += 1;
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          return shutdown(1, "mdpx: Chrome failed repeatedly\n");
        }
        try {
          await chrome.restart();
        } catch (restartError) {
          const reason = restartError instanceof Error ? restartError.message : restartError;
          return shutdown(1, `mdpx: could not restart Chrome: ${reason}\n`);
        }
        restarted = true;
      }
    }
  }

  function loadCurrentGeometry(): Promise<number> {
    const g = scheduler.viewState().geometry;
    return chrome.load(htmlPath, g.cssWidth, g.renderScale);
  }

  /**
   * Load and collect the line anchors in a single attempt (§4.9). Keeping them together rules out
   * the combination where attempt restarts Chrome, the page is rebuilt, and the load succeeds while
   * the anchors stay empty.
   */
  async function loadWithAnchors(): Promise<{ docHpx: number; anchors: Anchor[] }> {
    const docHpx = await loadCurrentGeometry();
    return { docHpx, anchors: await chrome.collectAnchors() };
  }

  /**
   * Keep one LineMap per generation, retaining only two: the displayed one and the newest.
   * Pruning by generation distance would grow without bound once renders keep failing and
   * displayGen falls behind.
   */
  function rememberLineMap(gen: number, map: LineMap): void {
    const shown = scheduler.viewState().displayGen;
    lineMaps.set(gen, map);
    for (const k of lineMaps.keys()) if (k !== gen && k !== shown) lineMaps.delete(k);
  }

  async function runRender(gen: number): Promise<void> {
    // A failed file read or HTML build is not a Chrome fault (a transient missing file, say).
    // Keep the current frame on screen and only fold the pipeline
    let md: string;
    let laidOut: readonly boolean[];
    try {
      md = await readFile(mdPath, "utf8");
      const built = await buildHtml({ markdown: md, mdDir, assets, theme });
      await writeFile(htmlPath, built.html);
      laidOut = built.laidOut;
    } catch {
      if (!shuttingDown) execute(scheduler.dispatch({ type: "renderFailed", gen }));
      return;
    }
    let loaded: { docHpx: number; anchors: Anchor[] };
    try {
      loaded = await attempt(loadWithAnchors);
    } catch (e) {
      // Only ContentError reaches here; attempt handles the rest by restarting or exiting.
      if (e instanceof ContentError && !shuttingDown) {
        execute(scheduler.dispatch({ type: "renderFailed", gen }));
        return;
      }
      throw e;
    }
    // Anchor tops are CSS px; docHpx is physical px (chrome.load multiplies by CSS_SCALE)
    rememberLineMap(
      gen,
      buildLineMap(loaded.anchors, countLines(md), loaded.docHpx / CSS_SCALE, laidOut),
    );
    if (!shuttingDown) {
      execute(scheduler.dispatch({ type: "renderDone", gen, docHpx: loaded.docHpx }));
    }
  }

  async function runShoot(action: ShootAction): Promise<void> {
    const { gen, tileIndex, clip } = action;
    let base64: string;
    try {
      base64 = await attempt(async (restarted) => {
        // A restart lost the page state, so restore it before capturing
        if (restarted) await loadCurrentGeometry();
        return chrome.shoot(clip);
      });
    } catch (e) {
      // The reload after a restart failed on the content (rare). Fold the pipeline and keep the current frame.
      if (e instanceof ContentError && !shuttingDown) {
        execute(scheduler.dispatch({ type: "renderFailed", gen }));
        return;
      }
      throw e;
    }
    if (shuttingDown) return;
    // Fire-and-forget transfer: tileReady is settled right after transmit (§4.4, "each tile once per
    // generation"). kitty suppresses the success reply with q=1, and a refused transfer's APC error
    // reply arrives later only for term's parser to discard it (there is no correlation machinery to
    // await a reply and recapture). A region whose transfer failed renders as an empty placement and
    // can stay blank until the next generation. §4.4's resident budget is kept inside the terminal's
    // image storage limit, so running out of capacity is not expected.
    term.write(transmit(imageId(gen, tileIndex), base64));
    execute(scheduler.dispatch({ type: "tileReady", gen, tileIndex }));
  }

  function execute(actions: Action[]): void {
    for (const a of actions) {
      switch (a.type) {
        case "redraw": {
          const frame = renderFrame(scheduler.viewState(), fileName, lastPlacements);
          term.write(frame.escape);
          lastPlacements = frame.placements;
          break;
        }
        case "deleteGen":
          term.write(a.imageIds.map(deleteImage).join(""));
          break;
        case "render":
          void runRender(a.gen);
          break;
        case "shoot":
          void runShoot(a);
          break;
      }
    }
  }

  /**
   * Project the source line currently at the top of the screen onto the nvim cursor (§4.9).
   *
   * A jump to the end (`G`) sends the document's last line instead of the interpolated value: `G`
   * means "end of the document", not "first line of the last screen". **The decision is made on the
   * key kind** — substituting "did scrollPx hit its maximum" would jump to the last line after a
   * single `j` in a document one line taller than the screen.
   */
  function syncCursor(delta: ScrollDelta): void {
    const v = scheduler.viewState();
    if (v.displayGen === null) return;
    const map = lineMaps.get(v.displayGen);
    if (!map) return;
    nvim.send(lineAt(map, v.scrollPx / CSS_SCALE, delta.kind === "bottom"));
  }

  // Now that the geometry is settled, swap the startup quit-only handler for the real key handler.
  term.onKey((k) => {
    if (shuttingDown) return;
    if (k.type === "quit") return void shutdown(0);
    execute(scheduler.dispatch({ type: "key", delta: k.delta }));
    // Only key-driven scrolls trigger a send (§4.9). Saves and resizes do not — having mdpx's
    // re-render move the cursor right after someone saved an edit in nvim would tug at the hand
    // that is typing. Keep the causality intact: nvim moves only when mdpx is operated.
    // Do not narrow this to "scrollPx changed" either: a document that fits on one screen keeps
    // scrollPx at 0, and narrowing would mean `G` never sends anything
    syncCursor(k.delta);
  });

  // Rapid resizes can resolve an older query late, so seq keeps only the newest from winning.
  let resizeSeq = 0;
  term.onResizeEvent(() => {
    const seq = ++resizeSeq;
    void (async () => {
      if (shuttingDown) return;
      const c = await resolveCell();
      if (!c || shuttingDown || seq !== resizeSeq) return; // a later resize is pending; drop this one (keeping the old geometry)
      execute(scheduler.dispatch({ type: "resize", geometry: term.geometry(c) }));
    })();
  });

  // fs.watch can throw synchronously on ENOENT/EMFILE. Restore the terminal, Chrome, and tmpdir before exiting.
  try {
    watcher = watch(mdDir, (_event, changed) => {
      // Watch the parent directory and filter on the target's basename (a sibling's change must not reload)
      if (changed !== null && changed.normalize("NFC").toLowerCase() !== watchTarget) return;
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        debounce = null;
        if (!shuttingDown) execute(scheduler.dispatch({ type: "trigger" }));
      }, WATCH_DEBOUNCE_MS);
    });
  } catch (e) {
    return shutdown(1, `mdpx: cannot watch the directory: ${e instanceof Error ? e.message : e}\n`);
  }

  term.enterAltScreen();
  // From here a synchronous throw rejects main(), whose catch does not restore the terminal, and
  // alt-screen is already entered — so route it through shutdown.
  try {
    execute(scheduler.dispatch({ type: "trigger" })); // first render
  } catch (e) {
    return shutdown(1, `mdpx: ${e instanceof Error ? e.stack : e}\n`);
  }
}

main().catch((e) => {
  process.stderr.write(sanitizeBlock(`mdpx: ${e?.stack ?? e}\n`));
  process.exit(1);
});
