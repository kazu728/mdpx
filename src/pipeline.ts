import { readFile, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Chrome, ContentError } from "./chrome.ts";
import { buildHtml, type Assets, type Theme } from "./html.ts";
import { deleteImage, imageId, transmit } from "./kitty.ts";
import { Scheduler, type Action, type SchedulerEvent } from "./scheduler.ts";
import { renderFrame, Term } from "./term.ts";
import { toCssPx, toScreenPx, type Geometry } from "./geometry.ts";

type ShootAction = Extract<Action, { type: "shoot" }>;

interface PipelineDeps {
  chrome: Pick<Chrome, "load" | "shoot">;
  scheduler: Scheduler;
  term: Pick<Term, "write">;
  mdPath: string;
  htmlDir: string;
  assets: Assets;
  isShuttingDown: () => boolean;
  onFatal: (error: unknown) => Promise<never>;
}

export class Pipeline {
  private lastPlacements: number[] = [];
  private lastEscape = "";
  private theme: Theme = "light";
  private page: Promise<unknown> = Promise.resolve();
  private loaded: { gen: number; geometry: Geometry } | null = null;

  constructor(private readonly deps: PipelineDeps) {}

  dispatch(event: SchedulerEvent): void {
    if (this.deps.isShuttingDown()) return;
    const actions = this.deps.scheduler.dispatch(event);
    // Drawn before the actions so that deleted images are no longer placed.
    this.redraw();
    this.execute(actions);
  }

  private execute(actions: Action[]): void {
    const { term } = this.deps;
    for (const a of actions) {
      switch (a.type) {
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
    this.dispatch({ type: "trigger" });
  }

  private redraw(): void {
    const { scheduler, term, mdPath } = this.deps;
    const frame = renderFrame(scheduler.viewState(), basename(mdPath), this.lastPlacements);
    if (frame.escape !== this.lastEscape) {
      term.write(frame.escape);
      this.lastEscape = frame.escape;
    }
    this.lastPlacements = frame.placements;
  }

  private onPage<T>(work: () => Promise<T>): Promise<T> {
    const turn = this.page.then(work);
    this.page = turn.catch(() => {});
    return turn;
  }

  private htmlFor(gen: number): string {
    return join(this.deps.htmlDir, `gen-${gen}.html`);
  }

  private async loadGenDocument(gen: number): Promise<number> {
    const { chrome, scheduler } = this.deps;
    const g = scheduler.viewState().geometry;
    this.loaded = null;
    const h = await chrome.load(this.htmlFor(gen), g.viewportWidthCssPx, g.deviceScaleFactor);
    this.loaded = { gen, geometry: g };
    return toScreenPx(h, g.cellHpx);
  }

  private releaseGen(gen: number): void {
    // A queued or in-flight load may still need this generation's file.
    void this.onPage(() => unlink(this.htmlFor(gen)).catch(() => {}));
  }

  private async handleChromeError(e: unknown, gen: number): Promise<void> {
    const { isShuttingDown, onFatal } = this.deps;
    if (e instanceof ContentError) {
      this.dispatch({ type: "renderFailed", gen });
      return;
    }
    if (!isShuttingDown()) await onFatal(e);
  }

  private async runRender(gen: number): Promise<void> {
    const { mdPath, assets } = this.deps;
    try {
      const markdown = await readFile(mdPath, "utf8");
      const html = await buildHtml({
        markdown,
        mdDir: dirname(mdPath),
        assets,
        theme: this.theme,
      });
      await writeFile(this.htmlFor(gen), html);
    } catch {
      this.dispatch({ type: "renderFailed", gen });
      return;
    }
    let documentHeightPx: number;
    try {
      documentHeightPx = await this.onPage(() => this.loadGenDocument(gen));
    } catch (e) {
      await this.handleChromeError(e, gen);
      return;
    }
    this.dispatch({ type: "renderDone", gen, documentHeightPx });
  }

  private async runShoot(action: ShootAction): Promise<void> {
    const { chrome, term, isShuttingDown } = this.deps;
    const { gen, tileIndex, tile } = action;
    let base64: string;
    try {
      base64 = await this.onPage(async () => {
        if (this.loaded?.gen !== gen) await this.loadGenDocument(gen);
        const { cellHpx } = this.loaded!.geometry;
        return chrome.shoot(toCssPx(tile.topPx, cellHpx), toCssPx(tile.heightPx, cellHpx));
      });
    } catch (e) {
      await this.handleChromeError(e, gen);
      return;
    }
    if (isShuttingDown()) return;
    term.write(transmit(imageId(gen, tileIndex), base64));
    this.dispatch({ type: "tileReady", gen, tileIndex });
  }
}
