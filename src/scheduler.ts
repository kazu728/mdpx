import { sameRaster, type Geometry } from "./geometry.ts";
import {
  anchorAt,
  buildLayout,
  clampTop,
  headingRows,
  maxTop,
  prefetchOrder,
  topFor,
  visibleImageKeys,
  type CaptureRef,
  type CapturedImage,
  type Layout,
  type ScrollDirection,
  type Slice,
  type SyncedLayout,
} from "./layout.ts";

export type ScrollDelta =
  | { kind: "lines"; n: number }
  | { kind: "halfpage"; dir: 1 | -1 }
  | { kind: "top" }
  | { kind: "bottom" }
  | { kind: "heading"; dir: 1 | -1 };

/** Time arrives with the events; the scheduler never reads a clock. */
export type SchedulerEvent =
  | { type: "fileChanged"; at: number }
  | { type: "resize"; geometry: Geometry; at: number }
  | { type: "key"; delta: ScrollDelta; at: number }
  | { type: "synced"; layout: SyncedLayout; at: number }
  | { type: "syncFailed"; at: number }
  | { type: "captured"; imageKey: string; id: number; image: CapturedImage; at: number }
  | { type: "captureFailed"; imageKey: string; id: number; gone: boolean; at: number }
  | { type: "tick"; at: number }
  | { type: "hardRefresh"; at: number };

export type Action =
  /** Render the source and sync the page at the current geometry. */
  | { type: "sync" }
  /** Screenshot the slice, transmit it as image `id`, then report `captured`. */
  | { type: "capture"; imageKey: string; id: number; ref: CaptureRef }
  /** Free these images in the terminal. */
  | { type: "evict"; ids: number[] }
  /** Reload the page from scratch. */
  | { type: "resetPage" };

export interface Step {
  readonly actions: Action[];
  /** Dispatch a tick no later than this. */
  readonly wakeAt: number | null;
}

export type Status = "idle" | "rendering" | "updating" | "scrolling" | "render failed" | "update failed" | "scroll failed";

export interface ResidentImage extends CapturedImage {
  readonly id: number;
}

export interface ViewState {
  readonly geometry: Geometry;
  readonly shown: Layout | null;
  readonly top: number;
  /** Images the terminal holds, by content key. */
  readonly images: ReadonlyMap<string, ResidentImage>;
  readonly marks: ReadonlySet<string>;
  readonly follow: boolean;
  readonly status: Status;
  readonly latencyMs: number | null;
}

export const MARK_MS = 1500;
/** Share of the terminal's image storage that prefetching may fill. */
const PREFETCH_SHARE = 0.8;

interface ImageEntry {
  readonly id: number;
  readonly bytes: number;
  /** Set once the terminal holds it. */
  image: CapturedImage | null;
}

/**
 * Invariants:
 * - At most one sync and one capture in flight.
 * - `shown` is replaced only by a layout whose visible slices are all resident at the top it
 *   will show, so the screen never shows a hole for a block it has.
 * - Ids are allocated here only, never reused, and an id is in `images` exactly while the
 *   terminal may hold it. Images are evicted with an action before their entry goes.
 * - Resident and in-flight bytes stay within the terminal's storage. A slice visible in
 *   `shown` is never evicted.
 * - Images are keyed by content, not by version: a new layout reuses every slice whose key
 *   survived, and undoing an edit finds the old pixels if they were not evicted.
 */
export class Scheduler {
  private geometry: Geometry;
  private shown: Layout | null = null;
  private next: Layout | null = null;
  private top = 0;
  private pendingTop: number | null = null;
  private follow = false;
  private direction: ScrollDirection = 0;
  private dirty = false;
  private syncing = false;
  private capturing = false;
  /** A capture found the page moved on from the layouts held here; wait for a fresh sync. */
  private stale = false;
  private images = new Map<string, ImageEntry>();
  private failedKeys = new Set<string>();
  private nextId = 1;
  private marks = new Map<string, number>();
  private failure: "render" | "update" | "scroll" | null = null;
  private editStartedAt: number | null = null;
  private latencyMs: number | null = null;
  private actions: Action[] = [];

  constructor(geometry: Geometry) {
    this.geometry = geometry;
  }

  private get viewRows(): number {
    return this.geometry.viewRows;
  }

  dispatch(event: SchedulerEvent): Step {
    switch (event.type) {
      case "fileChanged":
        this.dirty = true;
        this.failedKeys.clear();
        this.editStartedAt ??= event.at;
        break;
      case "resize":
        this.onResize(event.geometry);
        break;
      case "key":
        this.onKey(event.delta);
        break;
      case "synced":
        this.onSynced(event.layout);
        break;
      case "syncFailed":
        this.syncing = false;
        this.stale = false;
        this.failure = this.shown ? "update" : "render";
        break;
      case "captured":
        this.onCaptured(event.imageKey, event.id, event.image);
        break;
      case "captureFailed":
        this.onCaptureFailed(event.imageKey, event.id, event.gone);
        break;
      case "tick":
        break;
      case "hardRefresh":
        this.forgetImages();
        this.shown = null;
        this.next = null;
        this.pendingTop = null;
        this.actions.push({ type: "resetPage" });
        this.dirty = true;
        break;
    }
    for (const [key, expires] of this.marks) if (expires <= event.at) this.marks.delete(key);
    this.reconcile(event.at);
    const actions = this.actions;
    this.actions = [];
    const expiries = [...this.marks.values()];
    return { actions, wakeAt: expiries.length ? Math.min(...expiries) : null };
  }

  view(): ViewState {
    const images = new Map<string, ResidentImage>();
    for (const [key, e] of this.images) if (e.image) images.set(key, { id: e.id, ...e.image });
    return {
      geometry: this.geometry,
      shown: this.shown,
      top: this.top,
      images,
      marks: new Set(this.marks.keys()),
      follow: this.follow,
      status: this.status(),
      latencyMs: this.latencyMs,
    };
  }

  private status(): Status {
    if (this.pendingTop !== null) return "scrolling";
    if (this.dirty || this.syncing || this.next) return this.shown ? "updating" : "rendering";
    if (this.failure) return `${this.failure} failed`;
    return "idle";
  }

  private onResize(geometry: Geometry): void {
    const rasterChanged = !sameRaster(this.geometry.raster, geometry.raster);
    this.geometry = geometry;
    if (rasterChanged) {
      this.forgetImages();
      this.shown = null;
      this.next = null;
      this.pendingTop = null;
      this.dirty = true;
      return;
    }
    if (this.shown) {
      this.top = this.follow ? maxTop(this.shown, this.viewRows) : clampTop(this.shown, this.top, this.viewRows);
    }
    this.pendingTop = null;
  }

  /** Evicts every image; captures still in flight are evicted when they report back. */
  private forgetImages(): void {
    const ids = [...this.images.values()].filter((e) => e.image).map((e) => e.id);
    if (ids.length) this.actions.push({ type: "evict", ids });
    this.images.clear();
    this.failedKeys.clear();
  }

  private onKey(delta: ScrollDelta): void {
    const shown = this.shown;
    if (!shown) return;
    const from = this.pendingTop ?? this.top;
    const max = maxTop(shown, this.viewRows);
    let to = from;
    switch (delta.kind) {
      case "lines":
        to = from + delta.n;
        this.direction = Math.sign(delta.n) as ScrollDirection;
        break;
      case "halfpage":
        to = from + delta.dir * Math.max(1, Math.floor(this.viewRows / 2));
        this.direction = delta.dir;
        break;
      case "top":
        to = 0;
        this.direction = -1;
        break;
      case "bottom":
        to = max;
        this.direction = 1;
        break;
      case "heading": {
        const rows = headingRows(shown);
        const target = delta.dir > 0 ? rows.find((r) => r > from) : rows.findLast((r) => r < from);
        if (target !== undefined) to = target;
        this.direction = delta.dir;
        break;
      }
    }
    to = clampTop(shown, to, this.viewRows);
    // Like tail -f: G follows the end, and so does scrolling down onto it.
    this.follow =
      delta.kind === "bottom" ||
      ((delta.kind === "lines" || delta.kind === "halfpage") && this.direction > 0 && to === max);
    this.pendingTop = to === this.top ? null : to;
    if (this.failure === "scroll") this.failure = null;
  }

  private onSynced(synced: SyncedLayout): void {
    this.syncing = false;
    this.stale = false;
    if (!sameRaster(synced.raster, this.geometry.raster)) {
      // Laid out for a screen that is gone.
      this.dirty = true;
      return;
    }
    this.next = buildLayout(synced, this.geometry);
  }

  private onCaptured(imageKey: string, id: number, image: CapturedImage): void {
    this.capturing = false;
    const entry = this.images.get(imageKey);
    if (entry?.id === id) entry.image = image;
    // Forgotten while in flight (a resize or a refresh): the terminal holds it, nobody wants it.
    else this.actions.push({ type: "evict", ids: [id] });
  }

  private onCaptureFailed(imageKey: string, id: number, gone: boolean): void {
    this.capturing = false;
    if (this.images.get(imageKey)?.id === id) this.images.delete(imageKey);
    if (gone) {
      // The page moved on from the layout; only a fresh sync describes it again.
      this.dirty = true;
      this.stale = true;
      this.next = null;
      return;
    }
    this.failedKeys.add(imageKey);
  }

  private reconcile(at: number): void {
    if (this.dirty && !this.syncing) {
      this.dirty = false;
      this.syncing = true;
      this.actions.push({ type: "sync" });
    }
    this.settle(at);
    this.fetch();
  }

  private covers(layout: Layout, top: number): boolean {
    for (const key of visibleImageKeys(layout, top, this.viewRows)) {
      if (!this.images.get(key)?.image) return false;
    }
    return true;
  }

  private topForNext(next: Layout): number {
    if (this.follow) return maxTop(next, this.viewRows);
    const from = this.pendingTop ?? this.top;
    // At the very top, stay there, so an edit to the first lines shows up.
    if (!this.shown || from === 0) return clampTop(next, from, this.viewRows);
    return topFor(next, anchorAt(this.shown, from), this.viewRows, from);
  }

  private settle(at: number): void {
    if (this.pendingTop !== null && this.shown && this.covers(this.shown, this.pendingTop)) {
      this.top = this.pendingTop;
      this.pendingTop = null;
    }
    const next = this.next;
    if (!next) return;
    const top = this.topForNext(next);
    if (!this.covers(next, top)) return;
    if (this.shown) {
      const before = new Set(this.shown.blockKeys);
      for (const key of next.blockKeys) if (!before.has(key)) this.marks.set(key, at + MARK_MS);
    }
    this.shown = next;
    this.next = null;
    this.top = top;
    this.pendingTop = null;
    this.failure = null;
    if (!this.dirty && !this.syncing && this.editStartedAt !== null) {
      this.latencyMs = at - this.editStartedAt;
      this.editStartedAt = null;
    }
  }

  private fetch(): void {
    if (this.capturing || this.stale) return;
    const target = this.next
      ? { layout: this.next, top: this.topForNext(this.next) }
      : this.shown && this.pendingTop !== null
        ? { layout: this.shown, top: this.pendingTop }
        : null;
    if (target) {
      // Nothing is in flight here, so every entry is resident and the first absent key is the gap.
      const missing = [...visibleImageKeys(target.layout, target.top, this.viewRows)].find(
        (key) => !this.images.has(key),
      );
      if (missing === undefined) return;
      const slice = target.layout.slices.get(missing)!;
      if (!this.failedKeys.has(missing) && this.makeRoom(slice.bytes, this.protectedKeys(target))) {
        this.capture(slice);
      } else {
        this.giveUp(target.layout);
      }
      return;
    }
    if (this.shown) this.prefetch(this.shown);
  }

  private protectedKeys(target: { layout: Layout; top: number } | null): Set<string> {
    const keep = this.shown ? visibleImageKeys(this.shown, this.top, this.viewRows) : new Set<string>();
    if (target) for (const key of visibleImageKeys(target.layout, target.top, this.viewRows)) keep.add(key);
    return keep;
  }

  private giveUp(layout: Layout): void {
    if (layout === this.next) {
      this.next = null;
      this.failure = this.shown ? "update" : "render";
    } else {
      this.pendingTop = null;
      this.failure = "scroll";
    }
  }

  private prefetch(shown: Layout): void {
    if (this.failure === "scroll") return;
    const budget = Math.floor(this.geometry.storageBytes * PREFETCH_SHARE);
    const keep = new Set<string>();
    let bytes = 0;
    for (const slice of prefetchOrder(shown, this.top, this.viewRows, this.direction)) {
      if (bytes + slice.bytes > budget && keep.size > 0) break;
      bytes += slice.bytes;
      keep.add(slice.imageKey);
    }
    for (const key of keep) {
      if (this.images.has(key) || this.failedKeys.has(key)) continue;
      const slice = shown.slices.get(key)!;
      const protect = this.protectedKeys(null);
      for (const k of keep) protect.add(k);
      if (this.makeRoom(slice.bytes, protect)) this.capture(slice);
      return;
    }
  }

  private usedBytes(): number {
    let total = 0;
    for (const e of this.images.values()) total += e.bytes;
    return total;
  }

  /** Evicts the least useful resident images until `bytes` more fit. False if they cannot. */
  private makeRoom(bytes: number, keep: Set<string>): boolean {
    let free = this.geometry.storageBytes - this.usedBytes();
    if (free >= bytes) return true;
    const shown = this.shown;
    const distance = (key: string): number => {
      const slice = shown?.slices.get(key);
      if (!slice) return Infinity;
      return slice.rowEnd <= this.top ? this.top - slice.rowEnd : Math.max(0, slice.rowStart - this.top);
    };
    const candidates = [...this.images.entries()]
      .filter(([key, e]) => e.image && !keep.has(key))
      .sort((a, b) => distance(b[0]) - distance(a[0]));
    const ids: number[] = [];
    for (const [key, e] of candidates) {
      if (free >= bytes) break;
      this.images.delete(key);
      ids.push(e.id);
      free += e.bytes;
    }
    if (ids.length) this.actions.push({ type: "evict", ids });
    return free >= bytes;
  }

  private capture(slice: Slice): void {
    const id = this.nextId++;
    this.images.set(slice.imageKey, { id, bytes: slice.bytes, image: null });
    this.capturing = true;
    this.actions.push({ type: "capture", imageKey: slice.imageKey, id, ref: slice.capture });
  }
}
