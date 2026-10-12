#!/usr/bin/env node
import { realpathSync, statSync, watch, type FSWatcher } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { resolveAssets } from "./html.ts";
import { Chrome, resolveExecutable } from "./chrome.ts";
import { Pipeline } from "./pipeline.ts";
import { Scheduler } from "./scheduler.ts";
import { sanitizeTerminalBlock, Term } from "./term.ts";
import { resolveGeometry } from "./geometry.ts";

const CELL_QUERY_MS = 200;
const GRAPHICS_QUERY_TIMEOUT_MS = 200;
const WATCH_DEBOUNCE_MS = 100;
const CHROME_CLOSE_TIMEOUT_MS = 1500;
const UNSUPPORTED_TERMINAL = "run this in a terminal that supports the kitty graphics protocol";

function warn(msg: string): void {
  process.stderr.write(sanitizeTerminalBlock(`mdpx: ${msg}\n`));
}

function errorText(e: unknown): string {
  return e instanceof Error ? (e.stack ?? e.message) : String(e);
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function fail(msg: string): never {
  warn(msg);
  process.exit(1);
}

function resolveCliMdPath(argv: string[]): string {
  const arg = argv[0];
  if (!arg) fail("usage: mdpx <file.md>");
  try {
    const resolved = resolve(arg);
    if (statSync(resolved).isFile()) return realpathSync(resolved);
  } catch {}
  fail(`file not found: ${arg}`);
}

async function runApp(mdPath: string): Promise<void> {
  const mdDir = dirname(mdPath);
  const watchTarget = basename(mdPath).normalize("NFC").toLowerCase();

  if (!process.stdout.isTTY || !process.stdin.isTTY) fail(UNSUPPORTED_TERMINAL);

  const chromeExecutable = await resolveExecutable();
  if (!chromeExecutable) {
    fail(
      "no Chrome or Chromium found. Install Google Chrome or a non-Snap Chromium, or point PUPPETEER_EXECUTABLE_PATH at one",
    );
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
      await Promise.race([chrome.close(), sleep(CHROME_CLOSE_TIMEOUT_MS)]);
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
    } catch {}
    process.exit(code);
  }

  let started: Pipeline | null = null;
  term.onKey((k) => {
    if (k.type === "quit") return void shutdown(0);
    if (shuttingDown || !started) return;
    if (k.type === "theme") return started.toggleTheme();
    started.dispatch({ type: "key", delta: k.delta });
  });
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, () => void shutdown(0));
  process.on("uncaughtException", (e) => void shutdown(1, errorText(e)));
  process.on("unhandledRejection", (e) => void shutdown(1, errorText(e)));

  try {
    const cell = await term.queryCellSize(CELL_QUERY_MS);
    if (!cell || !(await term.queryKittyGraphics(GRAPHICS_QUERY_TIMEOUT_MS))) {
      return shutdown(1, UNSUPPORTED_TERMINAL);
    }

    const assets = resolveAssets();
    dir = await mkdtemp(join(tmpdir(), "mdpx-"));
    try {
      await chrome.launch();
    } catch (e) {
      return shutdown(1, `cannot launch Chrome (${chromeExecutable}): ${errorText(e)}`);
    }

    const pipeline = new Pipeline({
      chrome,
      scheduler: new Scheduler(resolveGeometry(term.size(), cell)),
      term,
      mdPath,
      htmlDir: dir,
      assets,
      isShuttingDown: () => shuttingDown,
      onFatal: (e) => shutdown(1, `Chrome failed: ${errorMessage(e)}`),
    });
    started = pipeline;

    let resizeSeq = 0;
    term.onResizeEvent(() => {
      const seq = ++resizeSeq;
      void (async () => {
        if (shuttingDown) return;
        const c = await term.queryCellSize(CELL_QUERY_MS);
        if (!c || shuttingDown || seq !== resizeSeq) return;
        pipeline.dispatch({ type: "resize", geometry: resolveGeometry(term.size(), c) });
      })();
    });

    try {
      watcher = watch(mdDir, (_event, changed) => {
        if (changed !== null && changed.normalize("NFC").toLowerCase() !== watchTarget) return;
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => {
          debounce = null;
          if (!shuttingDown) pipeline.dispatch({ type: "trigger" });
        }, WATCH_DEBOUNCE_MS);
      });
    } catch (e) {
      return shutdown(1, `cannot watch the directory: ${errorMessage(e)}`);
    }

    term.enterAltScreen();
    pipeline.dispatch({ type: "trigger" });
  } catch (e) {
    return shutdown(1, errorText(e));
  }
}

const mdPath = resolveCliMdPath(process.argv.slice(2));
runApp(mdPath).catch((e) => fail(errorText(e)));
