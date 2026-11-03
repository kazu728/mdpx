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
  | { type: "evict"; ids: number[] }
  | { type: "resetPage" };

export interface Step {
  readonly actions: Action[];
  readonly wakeAt: number | null;
}

export type Status = "idle" | "rendering" | "updating" | "scrolling" | "render failed" | "update failed" | "scroll failed";

export interface ResidentImage extends CapturedImage {
  readonly id: number;
}

/** What the scheduler is fetching images for: an update, or a scroll of the shown layout. */
export interface Target {
  readonly layout: Layout;
  readonly top: number;
}

export interface ViewState {
  readonly geometry: Geometry;
  readonly shown: Layout | null;
  readonly top: number;
  readonly images: ReadonlyMap<string, ResidentImage>;
  readonly marks: ReadonlySet<string>;
  readonly follow: boolean;
  readonly status: Status;
  readonly latencyMs: number | null;
  readonly target: Target | null;
}

export const MARK_MS = 1500;
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
 *   will show. The screen shows a hole only after a resize, or when the old screen and the
 *   target do not fit in storage together and the old one gives way; holes are filled again.
 * - Ids are allocated here only and never reused. A resident id is in `images` exactly while
 *   the terminal holds it, and is evicted with an action before its entry goes. A capture
 *   forgotten in flight (by a resize or a refresh) is evicted when it lands.
 * - Resident and in-flight bytes stay within the terminal's storage. A slice visible in
 *   `shown` is evicted only to give way to the target.
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
  private awaitingFreshSync = false;
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
        this.awaitingFreshSync = false;
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
      target: this.target(),
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
    this.follow =
      delta.kind === "bottom" ||
      ((delta.kind === "lines" || delta.kind === "halfpage") && this.direction > 0 && to === max);
    this.pendingTop = to === this.top ? null : to;
    if (this.failure === "scroll") this.failure = null;
  }

  private onSynced(synced: SyncedLayout): void {
    this.syncing = false;
    this.awaitingFreshSync = false;
    if (!sameRaster(synced.raster, this.geometry.raster)) {
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
      this.dirty = true;
      this.awaitingFreshSync = true;
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

  private target(): Target | null {
    if (this.next) return { layout: this.next, top: this.topForNext(this.next) };
    if (this.shown && this.pendingTop !== null) return { layout: this.shown, top: this.pendingTop };
    return null;
  }

  private missingVisible(target: Target): string | undefined {
    return [...visibleImageKeys(target.layout, target.top, this.viewRows)].find((key) => !this.images.get(key)?.image);
  }

  private fetch(): void {
    if (this.capturing || this.awaitingFreshSync) return;
    const target = this.target();
    if (target) {
      const missing = this.missingVisible(target);
      if (missing === undefined) return;
      const slice = target.layout.slices.get(missing)!;
      if (!this.failedKeys.has(missing) && (this.makeRoom(slice.maxBytes, this.protectedKeys(target)) || this.giveWay(target, slice))) {
        this.capture(slice);
      } else {
        this.giveUp(target.layout);
        this.fetch();
      }
      return;
    }
    if (this.shown) this.prefetch(this.shown);
  }

  private protectedKeys(target: Target | null): Set<string> {
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

  private giveWay(target: Target, slice: Slice): boolean {
    const keys = visibleImageKeys(target.layout, target.top, this.viewRows);
    let bytes = 0;
    for (const key of keys) bytes += target.layout.slices.get(key)!.maxBytes;
    return bytes <= this.geometry.storageBytes && this.makeRoom(slice.maxBytes, keys);
  }

  private prefetch(shown: Layout): void {
    const hole = this.missingVisible({ layout: shown, top: this.top });
    if (hole !== undefined && !this.failedKeys.has(hole)) {
      const slice = shown.slices.get(hole)!;
      if (this.makeRoom(slice.maxBytes, this.protectedKeys(null))) this.capture(slice);
      return;
    }
    if (this.failure === "scroll") return;
    const budget = Math.floor(this.geometry.storageBytes * PREFETCH_SHARE);
    const keep = new Set<string>();
    let bytes = 0;
    for (const slice of prefetchOrder(shown, this.top, this.viewRows, this.direction)) {
      if (bytes + slice.maxBytes > budget && keep.size > 0) break;
      bytes += slice.maxBytes;
      keep.add(slice.imageKey);
    }
    for (const key of keep) {
      if (this.images.has(key) || this.failedKeys.has(key)) continue;
      const slice = shown.slices.get(key)!;
      const protect = this.protectedKeys(null);
      for (const k of keep) protect.add(k);
      if (this.makeRoom(slice.maxBytes, protect)) this.capture(slice);
      return;
    }
  }

  private usedBytes(): number {
    let total = 0;
    for (const e of this.images.values()) total += e.bytes;
    return total;
  }

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
    this.images.set(slice.imageKey, { id, bytes: slice.maxBytes, image: null });
    this.capturing = true;
    this.actions.push({ type: "capture", imageKey: slice.imageKey, id, ref: slice.capture });
  }
}
