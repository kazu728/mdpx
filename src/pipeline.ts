import { readFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { deleteImage, transmit } from "./kitty.ts";
import type { CaptureRef, SyncedLayout } from "./layout.ts";
import { renderDocument, type Doc } from "./markdown.ts";
import type { Theme } from "./theme.ts";
import { CaptureGone, ContentError, type Capture } from "./page.ts";
import type { Geometry } from "./geometry.ts";
import { Scheduler, type Action, type SchedulerEvent } from "./scheduler.ts";
import { renderFrame, type PlacementId } from "./screen.ts";
import type { Term } from "./term.ts";

export interface PageLike {
  sync(doc: Doc, geometry: Geometry): Promise<SyncedLayout>;
  capture(ref: CaptureRef): Promise<Capture>;
  reset(): Promise<void>;
}

type CaptureAction = Extract<Action, { type: "capture" }>;

/** A scheduler event before the pipeline stamps its time. */
export type Input = SchedulerEvent extends infer E ? (E extends unknown ? Omit<E, "at"> : never) : never;

interface PipelineDeps {
  page: Promise<PageLike>;
  scheduler: Scheduler;
  term: Pick<Term, "write">;
  mdPath: string;
  theme: Theme;
  isShuttingDown: () => boolean;
  onFatal: (error: unknown) => Promise<never>;
  now?: () => number;
}

export class Pipeline {
  private lastPlacements: PlacementId[] = [];
  private lastContent = "";
  private theme: Theme;
  private queue: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: PipelineDeps) {
    this.theme = deps.theme;
    this.now = deps.now ?? (() => performance.now());
  }

  dispatch(input: Input): void {
    if (this.deps.isShuttingDown()) return;
    const step = this.deps.scheduler.dispatch({ ...input, at: this.now() } as SchedulerEvent);
    // Drawn before the actions, so an image about to be evicted is no longer placed.
    this.redraw();
    for (const action of step.actions) this.execute(action);
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (step.wakeAt !== null) {
      this.timer = setTimeout(() => this.dispatch({ type: "tick" }), Math.max(0, step.wakeAt - this.now()));
    }
  }

  toggleTheme(): void {
    this.theme = this.theme === "light" ? "dark" : "light";
    this.dispatch({ type: "fileChanged" });
  }

  private execute(action: Action): void {
    switch (action.type) {
      case "sync":
        void this.runSync();
        break;
      case "capture":
        void this.runCapture(action);
        break;
      case "evict":
        this.deps.term.write(action.ids.map(deleteImage).join(""));
        break;
      case "resetPage":
        void this.onPage((page) => page.reset()).catch((e) => this.handleChromeError(e, () => {}));
        break;
    }
  }

  private redraw(): void {
    const { scheduler, term, mdPath } = this.deps;
    const frame = renderFrame(scheduler.view(), basename(mdPath), this.lastPlacements);
    if (frame.content === this.lastContent) return;
    term.write(frame.escape);
    this.lastContent = frame.content;
    this.lastPlacements = frame.placements;
  }

  private onPage<T>(work: (page: PageLike) => Promise<T>): Promise<T> {
    const turn = this.queue.then(() => this.deps.page).then(work);
    this.queue = turn.catch(() => {});
    return turn;
  }

  private async handleChromeError(e: unknown, onContentError: () => void): Promise<void> {
    if (e instanceof ContentError) return onContentError();
    if (!this.deps.isShuttingDown()) await this.deps.onFatal(e);
  }

  private async runSync(): Promise<void> {
    const { mdPath, scheduler } = this.deps;
    let doc: Doc;
    try {
      doc = await renderDocument(await readFile(mdPath, "utf8"), { theme: this.theme, mdDir: dirname(mdPath) });
    } catch {
      this.dispatch({ type: "syncFailed" });
      return;
    }
    let layout: SyncedLayout;
    try {
      // The geometry is read when the page is free, so a resize while queued is honored.
      layout = await this.onPage((page) => page.sync(doc, scheduler.view().geometry));
    } catch (e) {
      await this.handleChromeError(e, () => this.dispatch({ type: "syncFailed" }));
      return;
    }
    this.dispatch({ type: "synced", layout });
  }

  private async runCapture({ imageKey, id, ref }: CaptureAction): Promise<void> {
    let shot: Capture;
    try {
      shot = await this.onPage((page) => page.capture(ref));
    } catch (e) {
      if (e instanceof CaptureGone) {
        this.dispatch({ type: "captureFailed", imageKey, id, gone: true });
        return;
      }
      await this.handleChromeError(e, () =>
        this.dispatch({ type: "captureFailed", imageKey, id, gone: false }),
      );
      return;
    }
    if (this.deps.isShuttingDown()) return;
    this.deps.term.write(transmit(id, shot.pngBase64));
    this.dispatch({
      type: "captured",
      imageKey,
      id,
      image: { contentTopImgPx: shot.contentTopImgPx, heightImgPx: shot.heightImgPx },
    });
  }
}
