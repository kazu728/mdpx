import { readFile, writeFile } from "node:fs/promises";
import { Chrome, ContentError } from "./chrome.ts";
import { renderFrame } from "./frame.ts";
import { buildHtml, type Assets } from "./html.ts";
import { deleteImage, imageId, transmit } from "./kitty.ts";
import {
  buildLineMap,
  countSourceLines,
  sourceLineAt,
  type Anchor,
  type LineMap,
} from "./linemap.ts";
import { Scheduler, type Action } from "./scheduler.ts";
import { Term } from "./term.ts";
import type { Theme } from "./theme.ts";
import { CSS_SCALE } from "./viewport.ts";

const MAX_CONSECUTIVE_CHROME_FAILURES = 2;

type ShootAction = Extract<Action, { type: "shoot" }>;

interface PipelineDeps {
  chrome: Chrome;
  scheduler: Scheduler;
  term: Term;
  mdPath: string;
  mdDir: string;
  fileName: string;
  htmlPath: string;
  assets: Assets;
  theme: Theme;
  isShuttingDown: () => boolean;
  onFatal: (message: string) => Promise<never>;
}

export class Pipeline {
  // Keep line maps per generation; lookups use only the displayed generation's map.
  private readonly lineMaps = new Map<number, LineMap>();
  private consecutiveFailures = 0;
  private lastPlacements: number[] = [];

  constructor(private readonly deps: PipelineDeps) {}

  execute(actions: Action[]): void {
    const { scheduler, term, fileName } = this.deps;
    for (const a of actions) {
      switch (a.type) {
        case "redraw": {
          const frame = renderFrame(scheduler.viewState(), fileName, this.lastPlacements);
          term.write(frame.escape);
          this.lastPlacements = frame.placements;
          break;
        }
        case "deleteGen":
          term.write(a.imageIds.map(deleteImage).join(""));
          break;
        case "render":
          void this.runRender(a.gen);
          break;
        case "shoot":
          void this.runShoot(a);
          break;
      }
    }
  }

  displayedSourceLine(jumpToEnd: boolean): number | null {
    const v = this.deps.scheduler.viewState();
    if (v.displayGen === null) return null;
    const map = this.lineMaps.get(v.displayGen);
    if (!map) return null;
    return sourceLineAt(map, v.scrollPx / CSS_SCALE, jumpToEnd);
  }

  // Retry Chrome faults; content errors stay with the caller.
  private async attempt<T>(fn: (restarted: boolean) => Promise<T>): Promise<T> {
    const { chrome, onFatal } = this.deps;
    let restarted = false;
    for (;;) {
      try {
        const r = await fn(restarted);
        this.consecutiveFailures = 0;
        return r;
      } catch (e) {
        if (e instanceof ContentError) throw e; // a restart fails the same way on the same content; keep the classes apart
        this.consecutiveFailures += 1;
        if (this.consecutiveFailures >= MAX_CONSECUTIVE_CHROME_FAILURES) {
          return onFatal("mdpx: Chrome failed repeatedly\n");
        }
        try {
          await chrome.restart();
        } catch (restartError) {
          const reason = restartError instanceof Error ? restartError.message : restartError;
          return onFatal(`mdpx: could not restart Chrome: ${reason}\n`);
        }
        restarted = true;
      }
    }
  }

  private loadCurrentGeometry(): Promise<number> {
    const { chrome, scheduler, htmlPath } = this.deps;
    const g = scheduler.viewState().geometry;
    return chrome.load(htmlPath, g.viewportWidthCssPx, g.renderScale);
  }

  /** Load and collect anchors together so they stay matched to the page. */
  private async loadWithAnchors(): Promise<{ documentHeightCssPx: number; anchors: Anchor[] }> {
    const documentHeightCssPx = await this.loadCurrentGeometry();
    return { documentHeightCssPx, anchors: await this.deps.chrome.collectAnchors() };
  }

  private rememberLineMap(gen: number, map: LineMap): void {
    const shown = this.deps.scheduler.viewState().displayGen;
    this.lineMaps.set(gen, map);
    for (const k of this.lineMaps.keys()) if (k !== gen && k !== shown) this.lineMaps.delete(k);
  }

  private async runRender(gen: number): Promise<void> {
    const { scheduler, mdPath, mdDir, assets, theme, htmlPath, isShuttingDown } = this.deps;
    let md: string;
    let laidOutSourceLines: ReadonlySet<number>;
    try {
      md = await readFile(mdPath, "utf8");
      const built = await buildHtml({ markdown: md, mdDir, assets, theme });
      await writeFile(htmlPath, built.html);
      laidOutSourceLines = built.laidOutSourceLines;
    } catch {
      if (!isShuttingDown()) this.execute(scheduler.dispatch({ type: "renderFailed", gen }));
      return;
    }
    let loaded: { documentHeightCssPx: number; anchors: Anchor[] };
    try {
      loaded = await this.attempt(() => this.loadWithAnchors());
    } catch (e) {
      if (e instanceof ContentError && !isShuttingDown()) {
        this.execute(scheduler.dispatch({ type: "renderFailed", gen }));
        return;
      }
      throw e;
    }
    this.rememberLineMap(
      gen,
      buildLineMap(
        loaded.anchors,
        countSourceLines(md),
        loaded.documentHeightCssPx,
        laidOutSourceLines,
      ),
    );
    if (!isShuttingDown()) {
      this.execute(
        scheduler.dispatch({
          type: "renderDone",
          gen,
          documentHeightPx: loaded.documentHeightCssPx * CSS_SCALE,
        }),
      );
    }
  }

  private async runShoot(action: ShootAction): Promise<void> {
    const { chrome, scheduler, term, isShuttingDown } = this.deps;
    const { gen, tileIndex, clip } = action;
    let base64: string;
    try {
      base64 = await this.attempt(async (restarted) => {
        if (restarted) await this.loadCurrentGeometry();
        return chrome.shoot(clip);
      });
    } catch (e) {
      if (e instanceof ContentError && !isShuttingDown()) {
        this.execute(scheduler.dispatch({ type: "renderFailed", gen }));
        return;
      }
      throw e;
    }
    if (isShuttingDown()) return;
    term.write(transmit(imageId(gen, tileIndex), base64));
    this.execute(scheduler.dispatch({ type: "tileReady", gen, tileIndex }));
  }
}
