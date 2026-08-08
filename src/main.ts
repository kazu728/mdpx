#!/usr/bin/env node
import { realpathSync, statSync, watch, type FSWatcher } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { resolveAssets, type Assets, type Theme } from "./html.ts";
import { Chrome, resolveExecutable } from "./chrome.ts";
import { NvimCursor, parseNvimEnv } from "./nvim.ts";
import { Pipeline } from "./pipeline.ts";
import { Scheduler } from "./scheduler.ts";
import { sanitizeTerminalBlock, sanitizeTerminalLine } from "./text.ts";
import { Term, parseCellSize } from "./term.ts";
import { resolveGeometry, type CellSize } from "./geometry.ts";

const CELL_QUERY_MS = 200;
const GRAPHICS_QUERY_TIMEOUT_MS = 200;
const WATCH_DEBOUNCE_MS = 100;
const CHROME_CLOSE_TIMEOUT_MS = 1500; // the terminal is already restored, so a stuck close must not block exit

// Sanitize every external string before writing to the bare terminal; it may contain CSI/OSC.
function warn(msg: string): void {
  process.stderr.write(sanitizeTerminalLine(`mdpx: ${msg}`) + "\n");
}

function usageExit(msg: string): never {
  warn(msg);
  process.exit(1);
}

function unsupportedTerminalExit(): never {
  process.stderr.write(
    "mdpx: run this in a terminal that supports the kitty graphics protocol\n" +
      "terminals that do not report cell metrics (some multiplexers) can set MDPX_CELL=<heightPx>,<widthPx>\n",
  );
  process.exit(1);
}

// Resolve symlinks so relative assets and watching use the target; report TOCTOU as a usage error.
function resolveMdPath(arg: string): string {
  try {
    const resolved = resolve(arg);
    if (statSync(resolved).isFile()) return realpathSync(resolved);
  } catch {}
  usageExit(`file not found: ${arg}`);
}

async function main(): Promise<void> {
  const arg = process.argv[2];
  if (!arg) usageExit("usage: mdpx <file.md>");
  const mdPath = resolveMdPath(arg);
  const mdDir = dirname(mdPath);
  const fileName = basename(mdPath);
  // Normalize macOS FSEvents names before comparing them.
  const watchTarget = fileName.normalize("NFC").toLowerCase();

  if (!process.stdout.isTTY || !process.stdin.isTTY) unsupportedTerminalExit();

  const mdpxCell = process.env.MDPX_CELL;
  const cellOverride = parseCellSize(mdpxCell);
  if (mdpxCell && !cellOverride) {
    warn(`ignoring MDPX_CELL (malformed <heightPx>,<widthPx> or out-of-range value): ${mdpxCell}`);
  }

  const nvimTarget = parseNvimEnv(process.env.MDPX_NVIM);
  if (nvimTarget.mode === "off" && nvimTarget.warning) warn(nvimTarget.warning);

  const chromeExecutable = await resolveExecutable();

  const term = new Term();
  term.enableInput();

  const chrome = new Chrome(chromeExecutable);
  const nvim = new NvimCursor(mdPath, nvimTarget);
  let dir: string | null = null;
  let watcher: FSWatcher | null = null;
  let debounce: ReturnType<typeof setTimeout> | null = null;
  let shuttingDown = false;

  async function shutdown(code: number, message?: string): Promise<never> {
    if (shuttingDown) return new Promise<never>(() => {});
    shuttingDown = true;
    // Always reach process.exit, even if cleanup throws synchronously.
    try {
      if (debounce) clearTimeout(debounce);
      watcher?.close();
      nvim.close();
      term.restore();
      if (message) process.stderr.write(sanitizeTerminalBlock(message));
      await Promise.race([chrome.close(), new Promise((r) => setTimeout(r, CHROME_CLOSE_TIMEOUT_MS))]);
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
    } catch {}
    process.exit(code);
  }

  // Install exit handlers before startup so cleanup also covers Chrome launch.
  term.onKey((k) => {
    if (k.type === "quit") void shutdown(0);
  });
  // Handle SIGHUP too so a closed terminal does not orphan raw input, the watcher, or the temp dir.
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, () => void shutdown(0));
  process.on("uncaughtException", (e) => void shutdown(1, `mdpx: ${e?.stack ?? e}\n`));
  process.on("unhandledRejection", (e) => {
    void shutdown(1, `mdpx: ${e instanceof Error ? e.stack : e}\n`);
  });

  const resolveCell = async (): Promise<CellSize | null> =>
    cellOverride ?? (await term.queryCellSize(CELL_QUERY_MS));

  const cell = await resolveCell();
  if (!cell) {
    term.restore();
    unsupportedTerminalExit();
  }
  if (!cellOverride && !(await term.queryKittyGraphics(GRAPHICS_QUERY_TIMEOUT_MS))) {
    term.restore();
    unsupportedTerminalExit();
  }

  let assets: Record<Theme, Assets>;
  try {
    // Resolve both themes up front so a missing stylesheet fails at startup, not on the first toggle.
    assets = { light: resolveAssets("light"), dark: resolveAssets("dark") };
    dir = await mkdtemp(join(tmpdir(), "mdpx-"));
  } catch (e) {
    return shutdown(1, `mdpx: ${e instanceof Error ? e.stack : e}\n`);
  }
  try {
    await chrome.launch();
  } catch (e) {
    return shutdown(
      1,
      chromeExecutable
        ? `mdpx: cannot launch Chrome (${chromeExecutable}): ${e instanceof Error ? e.stack : e}\n`
        : "mdpx: no Chromium found. Install Google Chrome, or point PUPPETEER_EXECUTABLE_PATH at a Chromium binary\n",
    );
  }
  const htmlPath = join(dir, "view.html");

  const scheduler = new Scheduler(resolveGeometry(term.size(), cell));
  const pipeline = new Pipeline({
    chrome,
    scheduler,
    term,
    mdPath,
    mdDir,
    fileName,
    htmlPath,
    assets,
    isShuttingDown: () => shuttingDown,
    onFatal: (message) => shutdown(1, message),
  });

  term.onKey((k) => {
    if (shuttingDown) return;
    if (k.type === "quit") return void shutdown(0);
    if (k.type === "theme") return pipeline.toggleTheme();
    pipeline.execute(scheduler.dispatch({ type: "key", delta: k.delta }));
    // Cursor sync is caused by keys only; renders and resizes must not move the editor.
    const line = pipeline.displayedSourceLine(k.delta.kind === "bottom");
    if (line !== null) nvim.send(line);
  });

  // Rapid resizes can resolve an older query late, so seq keeps only the newest from winning.
  let resizeSeq = 0;
  term.onResizeEvent(() => {
    const seq = ++resizeSeq;
    void (async () => {
      if (shuttingDown) return;
      const c = await resolveCell();
      if (!c || shuttingDown || seq !== resizeSeq) return;
      pipeline.execute(scheduler.dispatch({ type: "resize", geometry: resolveGeometry(term.size(), c) }));
    })();
  });

  try {
    watcher = watch(mdDir, (_event, changed) => {
      if (changed !== null && changed.normalize("NFC").toLowerCase() !== watchTarget) return;
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        debounce = null;
        if (!shuttingDown) pipeline.execute(scheduler.dispatch({ type: "trigger" }));
      }, WATCH_DEBOUNCE_MS);
    });
  } catch (e) {
    return shutdown(1, `mdpx: cannot watch the directory: ${e instanceof Error ? e.message : e}\n`);
  }

  term.enterAltScreen();
  // From here a synchronous throw rejects main(), whose catch does not restore the terminal, and
  // alt-screen is already entered — so route it through shutdown.
  try {
    pipeline.execute(scheduler.dispatch({ type: "trigger" }));
  } catch (e) {
    return shutdown(1, `mdpx: ${e instanceof Error ? e.stack : e}\n`);
  }
}

main().catch((e) => {
  process.stderr.write(sanitizeTerminalBlock(`mdpx: ${e?.stack ?? e}\n`));
  process.exit(1);
});
