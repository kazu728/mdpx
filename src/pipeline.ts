import { readFile, unlink, writeFile } from "node:fs/promises";
import { Chrome, ContentError } from "./chrome.ts";
import { renderFrame } from "./frame.ts";
import { buildHtml, type Assets, type Theme } from "./html.ts";
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
import { CSS_SCALE } from "./viewport.ts";

const MAX_CONSECUTIVE_CHROME_FAILURES = 2;

type ShootAction = Extract<Action, { type: "shoot" }>;

interface PipelineDeps {
  chrome: Pick<Chrome, "load" | "collectAnchors" | "shoot" | "restart" | "imagesPending" | "waitForLateImages">;
  scheduler: Scheduler;
  term: Pick<Term, "write">;
  mdPath: string;
  mdDir: string;
  fileName: string;
  htmlPath: string;
  assets: Record<Theme, Assets>;
  isShuttingDown: () => boolean;
  onFatal: (message: string) => Promise<never>;
}

export class Pipeline {
  // Each generation owns its HTML file and line map; both are released when the generation ends.
  private readonly lineMaps = new Map<number, LineMap>();
  private consecutiveFailures = 0;
  private lastPlacements: number[] = [];
  private lastEscape = "";
  private theme: Theme = "light";
  private page: Promise<unknown> = Promise.resolve();
  private loadedGen: number | null = null;

  constructor(private readonly deps: PipelineDeps) {}

  execute(actions: Action[]): void {
    const { scheduler, term, fileName } = this.deps;
    for (const a of actions) {
      switch (a.type) {
        case "redraw": {
          const frame = renderFrame(scheduler.viewState(), fileName, this.lastPlacements);
          // Prefetch completions redraw with no visible or status change; resending the identical
          // frame only costs erase-and-replace bytes inside the sync block, so skip it.
          if (frame.escape !== this.lastEscape) {
            term.write(frame.escape);
            this.lastEscape = frame.escape;
          }
          this.lastPlacements = frame.placements;
          break;
        }
        case "deleteGen":
          term.write(a.imageIds.map(deleteImage).join(""));
          break;
        case "releaseGen":
          this.releaseGen(a.gen);
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

  toggleTheme(): void {
    this.theme = this.theme === "light" ? "dark" : "light";
    this.execute(this.deps.scheduler.dispatch({ type: "trigger" }));
  }

  displayedSourceLine(jumpToEnd: boolean): number | null {
    const v = this.deps.scheduler.viewState();
    if (v.displayGen === null) return null;
    const map = this.lineMaps.get(v.displayGen);
    if (!map) return null;
    return sourceLineAt(map, v.scrollPx / CSS_SCALE, jumpToEnd);
  }

  /** A capture interrupted by a navigation never settles, and wedges every later capture. */
  private onPage<T>(work: () => Promise<T>): Promise<T> {
    const turn = this.page.then(work);
    this.page = turn.catch(() => {});
    return turn;
  }

  private async attempt<T>(fn: () => Promise<T>): Promise<T> {
    const { chrome, onFatal } = this.deps;
    for (;;) {
      try {
        const r = await fn();
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
        this.loadedGen = null;
      }
    }
  }

  private htmlFor(gen: number): string {
    return `${this.deps.htmlPath}.gen-${gen}.html`;
  }

  private loadGenDocument(gen: number): Promise<number> {
    const { chrome, scheduler } = this.deps;
    const g = scheduler.viewState().geometry;
    // Invalidate first: a failed load taints the page, so a stale match must never skip reload.
    this.loadedGen = null;
    return chrome.load(this.htmlFor(gen), g.viewportWidthCssPx, g.renderScale).then((h) => {
      this.loadedGen = gen;
      return h;
    });
  }

  /** Load and collect anchors together so they stay matched to the page. */
  private async loadWithAnchors(
    gen: number,
  ): Promise<{ documentHeightCssPx: number; anchors: Anchor[] }> {
    const documentHeightCssPx = await this.loadGenDocument(gen);
    return { documentHeightCssPx, anchors: await this.deps.chrome.collectAnchors() };
  }

  private rememberLineMap(gen: number, map: LineMap): void {
    this.lineMaps.set(gen, map);
  }

  /** A generation ends in the scheduler; its HTML and map end here. */
  private releaseGen(gen: number): void {
    this.lineMaps.delete(gen);
    if (this.loadedGen === gen) this.loadedGen = null;
    unlink(this.htmlFor(gen)).catch(() => {});
  }

  private async runRender(gen: number): Promise<void> {
    const { scheduler, mdPath, mdDir, assets, isShuttingDown } = this.deps;
    let md: string;
    let laidOutSourceLines: ReadonlySet<number>;
    try {
      md = await readFile(mdPath, "utf8");
      const built = await buildHtml({ markdown: md, mdDir, assets: assets[this.theme], theme: this.theme });
      await writeFile(this.htmlFor(gen), built.html);
      laidOutSourceLines = built.laidOutSourceLines;
    } catch {
      if (!isShuttingDown()) this.execute(scheduler.dispatch({ type: "renderFailed", gen }));
      return;
    }
    let loaded: { documentHeightCssPx: number; anchors: Anchor[] };
    try {
      loaded = await this.onPage(() => this.attempt(() => this.loadWithAnchors(gen)));
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
      base64 = await this.onPage(() =>
        this.attempt(async () => {
          if (this.loadedGen !== gen) await this.loadGenDocument(gen);
          return chrome.shoot(clip);
        }),
      );
    } catch (e) {
      if (e instanceof ContentError && !isShuttingDown()) {
        this.execute(scheduler.dispatch({ type: "renderFailed", gen }));
        return;
      }
      throw e;
    }
    if (isShuttingDown()) return;
    term.write(transmit(imageId(gen, tileIndex), base64));
    const before = scheduler.viewState().displayGen;
    this.execute(scheduler.dispatch({ type: "tileReady", gen, tileIndex }));
    if (scheduler.viewState().displayGen === gen && before !== gen) {
      void this.settleLateImages(gen);
    }
  }

  /**
   * Images decoded after the initial measure leave stale tiles: shifted layout, or same-box
   * pixels for dimension-specified images that height comparison alone would miss. Re-render
   * once the stragglers finish; a still-pending image after the budget keeps current pixels.
   */
  private async settleLateImages(gen: number): Promise<void> {
    const { chrome, scheduler, isShuttingDown } = this.deps;
    try {
      if (isShuttingDown() || this.loadedGen !== gen) return;
      if (!(await chrome.imagesPending())) return;
      await chrome.waitForLateImages();
      if (isShuttingDown() || this.loadedGen !== gen) return;
      if (scheduler.viewState().displayGen !== gen) return;
      if (await chrome.imagesPending()) return;
      this.execute(scheduler.dispatch({ type: "trigger" }));
    } catch {
      // Best-effort background check: a broken page surfaces through the normal capture path.
    }
  }
}
