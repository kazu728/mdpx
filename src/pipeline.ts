import { readFile, unlink, writeFile } from "node:fs/promises";
import { Chrome, ContentError } from "./chrome.ts";
import { renderFrame } from "./frame.ts";
import { buildHtml, type Assets, type Theme } from "./html.ts";
import { deleteImage, imageId, transmit } from "./kitty.ts";
import { Scheduler, type Action } from "./scheduler.ts";
import { Term } from "./term.ts";
import { CSS_SCALE } from "./viewport.ts";

type ShootAction = Extract<Action, { type: "shoot" }>;

interface PipelineDeps {
  chrome: Pick<Chrome, "load" | "shoot">;
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

  private onPage<T>(work: () => Promise<T>): Promise<T> {
    const turn = this.page.then(work);
    this.page = turn.catch(() => {});
    return turn;
  }

  private htmlFor(gen: number): string {
    return `${this.deps.htmlPath}.gen-${gen}.html`;
  }

  private async loadGenDocument(gen: number): Promise<number> {
    const { chrome, scheduler } = this.deps;
    const g = scheduler.viewState().geometry;
    this.loadedGen = null;
    const h = await chrome.load(this.htmlFor(gen), g.viewportWidthCssPx, g.renderScale);
    this.loadedGen = gen;
    return h;
  }

  private releaseGen(gen: number): void {
    // A queued or in-flight load may still need this generation's file.
    void this.onPage(() => unlink(this.htmlFor(gen)).catch(() => {}));
  }

  private async handleChromeError(e: unknown, gen: number): Promise<void> {
    const { scheduler, isShuttingDown } = this.deps;
    if (e instanceof ContentError) {
      if (!isShuttingDown()) this.execute(scheduler.dispatch({ type: "renderFailed", gen }));
      return;
    }
    if (!isShuttingDown()) {
      const reason = e instanceof Error ? e.message : String(e);
      await this.deps.onFatal(`mdpx: Chrome failed: ${reason}\n`);
    }
  }

  private async runRender(gen: number): Promise<void> {
    const { scheduler, mdPath, mdDir, assets, isShuttingDown } = this.deps;
    let md: string;
    try {
      md = await readFile(mdPath, "utf8");
      const { html } = await buildHtml({
        markdown: md,
        mdDir,
        assets: assets[this.theme],
        theme: this.theme,
      });
      await writeFile(this.htmlFor(gen), html);
    } catch {
      if (!isShuttingDown()) this.execute(scheduler.dispatch({ type: "renderFailed", gen }));
      return;
    }
    let documentHeightCssPx: number;
    try {
      documentHeightCssPx = await this.onPage(() => this.loadGenDocument(gen));
    } catch (e) {
      await this.handleChromeError(e, gen);
      return;
    }
    if (!isShuttingDown()) {
      this.execute(
        scheduler.dispatch({
          type: "renderDone",
          gen,
          documentHeightPx: documentHeightCssPx * CSS_SCALE,
        }),
      );
    }
  }

  private async runShoot(action: ShootAction): Promise<void> {
    const { chrome, scheduler, term, isShuttingDown } = this.deps;
    const { gen, tileIndex, clip } = action;
    let base64: string;
    try {
      base64 = await this.onPage(async () => {
        if (this.loadedGen !== gen) await this.loadGenDocument(gen);
        return chrome.shoot(clip);
      });
    } catch (e) {
      await this.handleChromeError(e, gen);
      return;
    }
    if (isShuttingDown()) return;
    term.write(transmit(imageId(gen, tileIndex), base64));
    this.execute(scheduler.dispatch({ type: "tileReady", gen, tileIndex }));
  }
}
