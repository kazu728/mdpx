#!/usr/bin/env node
import { realpathSync, statSync, watch, type FSWatcher } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { resolveAssets, type Assets, type Theme } from "./html.ts";
import { Chrome, resolveExecutable } from "./chrome.ts";
import { Pipeline } from "./pipeline.ts";
import { Scheduler } from "./scheduler.ts";
import { sanitizeTerminalBlock, Term } from "./term.ts";
import { resolveGeometry } from "./geometry.ts";

const CELL_QUERY_MS = 200;
const GRAPHICS_QUERY_TIMEOUT_MS = 200;
const WATCH_DEBOUNCE_MS = 100;
const CHROME_CLOSE_TIMEOUT_MS = 1500;

function warn(msg: string): void {
  process.stderr.write(sanitizeTerminalBlock(`mdpx: ${msg}\n`));
}

function errorText(e: unknown): string {
  return e instanceof Error ? (e.stack ?? e.message) : String(e);
}

function usageExit(): never {
  warn("usage: mdpx <file.md>");
  process.exit(1);
}

function unsupportedTerminalExit(): never {
  warn("run this in a terminal that supports the kitty graphics protocol");
  process.exit(1);
}

function errorExit(e: unknown): never {
  warn(errorText(e));
  process.exit(1);
}

function resolveCliMdPath(argv: string[]): string {
  const arg = argv[0];
  if (!arg) usageExit();
  try {
    const resolved = resolve(arg);
    if (statSync(resolved).isFile()) return realpathSync(resolved);
  } catch {}
  warn(`file not found: ${arg}`);
  process.exit(1);
}

async function runApp(mdPath: string): Promise<void> {
  const mdDir = dirname(mdPath);
  const fileName = basename(mdPath);
  const watchTarget = fileName.normalize("NFC").toLowerCase();

  if (!process.stdout.isTTY || !process.stdin.isTTY) unsupportedTerminalExit();

  const chromeExecutable = await resolveExecutable();
  if (!chromeExecutable) {
    warn(
      "no Chrome or Chromium found. Install Google Chrome or a non-Snap Chromium, or point PUPPETEER_EXECUTABLE_PATH at one",
    );
    process.exit(1);
  }

  const term = new Term();
  term.enableInput();

  const chrome = new Chrome(chromeExecutable);
  let dir: string | null = null;
  let watcher: FSWatcher | null = null;
  let debounce: ReturnType<typeof setTimeout> | null = null;
  let shuttingDown = false;

  async function shutdown(code: number, message?: string): Promise<never> {
    if (shuttingDown) return new Promise<never>(() => {});
    shuttingDown = true;
    try {
      if (debounce) clearTimeout(debounce);
      watcher?.close();
      term.restore();
      if (message) warn(message);
      await Promise.race([chrome.close(), new Promise((r) => setTimeout(r, CHROME_CLOSE_TIMEOUT_MS))]);
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
    } catch {}
    process.exit(code);
  }

  let pipeline: Pipeline | null = null;
  term.onKey((k) => {
    if (k.type === "quit") return void shutdown(0);
    if (shuttingDown || !pipeline) return;
    if (k.type === "theme") return pipeline.toggleTheme();
    pipeline.execute(scheduler.dispatch({ type: "key", delta: k.delta }));
  });
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, () => void shutdown(0));
  process.on("uncaughtException", (e) => void shutdown(1, errorText(e)));
  process.on("unhandledRejection", (e) => void shutdown(1, errorText(e)));

  const cell = await term.queryCellSize(CELL_QUERY_MS);
  if (!cell || !(await term.queryKittyGraphics(GRAPHICS_QUERY_TIMEOUT_MS))) {
    term.restore();
    unsupportedTerminalExit();
  }

  let assets: Record<Theme, Assets>;
  try {
    assets = { light: resolveAssets("light"), dark: resolveAssets("dark") };
    dir = await mkdtemp(join(tmpdir(), "mdpx-"));
  } catch (e) {
    return shutdown(1, errorText(e));
  }
  try {
    await chrome.launch();
  } catch (e) {
    return shutdown(1, `cannot launch Chrome (${chromeExecutable}): ${errorText(e)}`);
  }

  const scheduler = new Scheduler(resolveGeometry(term.size(), cell));
  pipeline = new Pipeline({
    chrome,
    scheduler,
    term,
    mdPath,
    mdDir,
    fileName,
    htmlDir: dir,
    assets,
    isShuttingDown: () => shuttingDown,
    onFatal: (message) => shutdown(1, message),
  });

  let resizeSeq = 0;
  term.onResizeEvent(() => {
    const seq = ++resizeSeq;
    void (async () => {
      if (shuttingDown) return;
      const c = await term.queryCellSize(CELL_QUERY_MS);
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
    return shutdown(1, `cannot watch the directory: ${e instanceof Error ? e.message : e}`);
  }

  term.enterAltScreen();
  try {
    pipeline.execute(scheduler.dispatch({ type: "trigger" }));
  } catch (e) {
    return shutdown(1, errorText(e));
  }
}

const mdPath = resolveCliMdPath(process.argv.slice(2));
runApp(mdPath).catch(errorExit);
