#!/usr/bin/env bun
import { realpathSync, statSync, watch, type FSWatcher } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { buildHtml, resolveAssets, type Assets } from "./html.ts";
import { resolveTheme } from "./theme.ts";
import { Chrome, ContentError, resolveExecutable } from "./chrome.ts";
import { renderFrame } from "./frame.ts";
import { deleteImage, imageId, transmit } from "./kitty.ts";
import {
  buildLineMap,
  countSourceLines,
  sourceLineAt,
  type Anchor,
  type LineMap,
} from "./linemap.ts";
import { NvimCursor, parseNvimEnv } from "./nvim.ts";
import { Scheduler, type Action, type ScrollDelta } from "./scheduler.ts";
import { sanitizeTerminalBlock, sanitizeTerminalLine } from "./text.ts";
import { Term, parseCellSize, type CellSize } from "./term.ts";
import { CSS_SCALE } from "./viewport.ts";

const CELL_QUERY_MS = 200;
const GRAPHICS_QUERY_TIMEOUT_MS = 200;
const WATCH_DEBOUNCE_MS = 100;
const MAX_CONSECUTIVE_CHROME_FAILURES = 2;
const CHROME_CLOSE_TIMEOUT_MS = 1500; // the terminal is already restored, so a stuck close must not block exit

type ShootAction = Extract<Action, { type: "shoot" }>;

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
    "mdpx: run this in a terminal that supports kitty graphics (Ghostty/Kitty)\n" +
      'hint: open -na Ghostty --args --command="mdpx <path>"\n' +
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

  // Require TTYs on both stdin and stdout so raw input and rendering are available.
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
  // Keep line maps per generation; lookups use only the displayed generation's map.
  const lineMaps = new Map<number, LineMap>();
  let dir: string | null = null;
  let watcher: FSWatcher | null = null;
  let debounce: ReturnType<typeof setTimeout> | null = null;
  let scheduler: Scheduler;
  let consecutiveFailures = 0;
  let shuttingDown = false;
  let lastPlacements: number[] = [];

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

  // Probe 16t once; later reads fall back to TIOCGWINSZ when needed.
  const use16t = !cellOverride && (await term.queryCellSize(CELL_QUERY_MS)) !== null;
  const resolveCell = async (): Promise<CellSize | null> =>
    cellOverride ?? (use16t ? await term.queryCellSize(CELL_QUERY_MS) : null) ?? term.queryWinsizeCell();

  // Auto-detection requires a graphics reply; MDPX_CELL explicitly bypasses that probe.
  const cell = await resolveCell();
  if (!cell) {
    term.restore();
    unsupportedTerminalExit();
  }
  if (!cellOverride && !(await term.queryKittyGraphics(GRAPHICS_QUERY_TIMEOUT_MS))) {
    term.restore();
    unsupportedTerminalExit();
  }

  const theme = resolveTheme();

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
    return shutdown(
      1,
      chromeExecutable
        ? `mdpx: cannot launch Chrome (${chromeExecutable}): ${e instanceof Error ? e.stack : e}\n`
        : "mdpx: no Chromium found. Install Google Chrome, or point PUPPETEER_EXECUTABLE_PATH at a Chromium binary\n",
    );
  }
  const htmlPath = join(dir, "view.html");

  scheduler = new Scheduler(term.geometry(cell));

  // Retry Chrome faults; content errors stay with the caller.
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
        if (consecutiveFailures >= MAX_CONSECUTIVE_CHROME_FAILURES) {
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
    return chrome.load(htmlPath, g.viewportWidthCssPx, g.renderScale);
  }

  /** Load and collect anchors together so they stay matched to the page. */
  async function loadWithAnchors(): Promise<{ documentHeightPx: number; anchors: Anchor[] }> {
    const documentHeightPx = await loadCurrentGeometry();
    return { documentHeightPx, anchors: await chrome.collectAnchors() };
  }

  /** Retain only the displayed and newest line maps. */
  function rememberLineMap(gen: number, map: LineMap): void {
    const shown = scheduler.viewState().displayGen;
    lineMaps.set(gen, map);
    for (const k of lineMaps.keys()) if (k !== gen && k !== shown) lineMaps.delete(k);
  }

  async function runRender(gen: number): Promise<void> {
    let md: string;
    let laidOutSourceLines: ReadonlySet<number>;
    try {
      md = await readFile(mdPath, "utf8");
      const built = await buildHtml({ markdown: md, mdDir, assets, theme });
      await writeFile(htmlPath, built.html);
      laidOutSourceLines = built.laidOutSourceLines;
    } catch {
      if (!shuttingDown) execute(scheduler.dispatch({ type: "renderFailed", gen }));
      return;
    }
    let loaded: { documentHeightPx: number; anchors: Anchor[] };
    try {
      loaded = await attempt(loadWithAnchors);
    } catch (e) {
      if (e instanceof ContentError && !shuttingDown) {
        execute(scheduler.dispatch({ type: "renderFailed", gen }));
        return;
      }
      throw e;
    }
    rememberLineMap(
      gen,
      buildLineMap(
        loaded.anchors,
        countSourceLines(md),
        loaded.documentHeightPx / CSS_SCALE,
        laidOutSourceLines,
      ),
    );
    if (!shuttingDown) {
      execute(
        scheduler.dispatch({
          type: "renderDone",
          gen,
          documentHeightPx: loaded.documentHeightPx,
        }),
      );
    }
  }

  async function runShoot(action: ShootAction): Promise<void> {
    const { gen, tileIndex, clip } = action;
    let base64: string;
    try {
      base64 = await attempt(async (restarted) => {
        if (restarted) await loadCurrentGeometry();
        return chrome.shoot(clip);
      });
    } catch (e) {
      if (e instanceof ContentError && !shuttingDown) {
        execute(scheduler.dispatch({ type: "renderFailed", gen }));
        return;
      }
      throw e;
    }
    if (shuttingDown) return;
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

  function syncCursor(delta: ScrollDelta): void {
    const v = scheduler.viewState();
    if (v.displayGen === null) return;
    const map = lineMaps.get(v.displayGen);
    if (!map) return;
    nvim.send(sourceLineAt(map, v.scrollPx / CSS_SCALE, delta.kind === "bottom"));
  }

  term.onKey((k) => {
    if (shuttingDown) return;
    if (k.type === "quit") return void shutdown(0);
    execute(scheduler.dispatch({ type: "key", delta: k.delta }));
    // Cursor sync is caused by keys only; renders and resizes must not move the editor.
    syncCursor(k.delta);
  });

  // Rapid resizes can resolve an older query late, so seq keeps only the newest from winning.
  let resizeSeq = 0;
  term.onResizeEvent(() => {
    const seq = ++resizeSeq;
    void (async () => {
      if (shuttingDown) return;
      const c = await resolveCell();
      if (!c || shuttingDown || seq !== resizeSeq) return;
      execute(scheduler.dispatch({ type: "resize", geometry: term.geometry(c) }));
    })();
  });

  try {
    watcher = watch(mdDir, (_event, changed) => {
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
    execute(scheduler.dispatch({ type: "trigger" }));
  } catch (e) {
    return shutdown(1, `mdpx: ${e instanceof Error ? e.stack : e}\n`);
  }
}

main().catch((e) => {
  process.stderr.write(sanitizeTerminalBlock(`mdpx: ${e?.stack ?? e}\n`));
  process.exit(1);
});
