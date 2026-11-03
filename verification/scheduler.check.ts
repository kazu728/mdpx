/**
 * Exhaustive, bounded model check of the real Scheduler (src/scheduler.ts).
 *
 * The page, the terminal and the user are modeled as an environment that may do anything
 * in any order: save one of a few documents, answer or fail the pending sync, deliver or fail
 * the capture in flight, press keys, resize, refresh. Every reachable state of
 * (scheduler, environment) is explored breadth first, up to a depth, and every transition is
 * checked against the properties below. A violation prints the shortest sequence of events
 * that reaches it.
 *
 * Usage: bun verification/scheduler.check.ts [--depth N]
 */
import { CELL_CSS_PX, maxSliceImagePx, resolveGeometry, type Geometry } from "../src/geometry.ts";
import { visibleImageKeys, type Layout, type SyncedLayout } from "../src/layout.ts";
import type { BlockKind } from "../src/markdown.ts";
import { Scheduler, type Action, type ScrollDelta, type SchedulerEvent } from "../src/scheduler.ts";

interface Spec {
  key: string;
  height: number;
  gap?: number;
  kind?: BlockKind;
}

/** Documents the file may hold. Together they insert, edit, delete, duplicate, merge and slice blocks. */
const DOCS: Spec[][] = [
  [{ key: "A", height: 30, kind: "heading" }, { key: "B", height: 60 }, { key: "C", height: 30 }, { key: "T", height: 100 }],
  [{ key: "N", height: 40 }, { key: "A", height: 30, kind: "heading" }, { key: "B", height: 60 }, { key: "C", height: 30 }, { key: "T", height: 100 }],
  [{ key: "A", height: 30, kind: "heading" }, { key: "B2", height: 60 }, { key: "C", height: 30, gap: 4 }, { key: "T", height: 100 }],
  [{ key: "A", height: 30, kind: "heading" }, { key: "C", height: 30 }, { key: "A", height: 30, kind: "heading" }, { key: "T", height: 100 }],
  [{ key: "C", height: 30 }],
];

/** Slices of three rows, so the 100px block needs several. */
const SLICE_ROWS = 3;

/**
 * Terminal storage, in images of the tallest slice. "tight" cannot hold two screens of every
 * document, so it evicts constantly and some updates must give up; "roomy" holds two screens,
 * the most an update needs, so every update must also get through.
 */
const STORAGE = { tight: 4, roomy: 9 } as const;
type Storage = keyof typeof STORAGE;

function screen(cols: number, rows: number, storage: Storage): Geometry {
  const g = resolveGeometry({ cols, rows }, { cellHpx: 20, cellWpx: 10 }, { frameBytes: null, storageBytes: 0 });
  const raster = { ...g.raster, sliceRows: SLICE_ROWS };
  const largestSlice = g.imgWidthPx * maxSliceImagePx(SLICE_ROWS * CELL_CSS_PX, raster) * 4;
  return { ...g, raster, storageBytes: largestSlice * STORAGE[storage] };
}

/** The screens the terminal may have: a base, one with more rows, one wider. */
let SCREENS: Geometry[] = [];

const KEYS: ScrollDelta[] = [
  { kind: "lines", n: 1 },
  { kind: "lines", n: -1 },
  { kind: "halfpage", dir: 1 },
  { kind: "top" },
  { kind: "bottom" },
  { kind: "heading", dir: 1 },
];

function synced(doc: Spec[], g: Geometry): SyncedLayout {
  let y = 32;
  const blocks = doc.map((s, i) => {
    if (i > 0) y += s.gap ?? CELL_CSS_PX;
    const b = { key: s.key, kind: s.kind ?? ("other" as BlockKind), topCss: y, heightCss: s.height };
    y += s.height;
    return b;
  });
  return { raster: g.raster, theme: "light", blocks, docHeightCss: y + 32 };
}

type CaptureAction = Extract<Action, { type: "capture" }>;

interface Env {
  doc: number;
  screen: number;
  /** The pending sync, with the screen it was asked for. */
  sync: { screen: number } | null;
  capture: CaptureAction | null;
  /** Images the terminal holds: id -> bytes. */
  terminal: Map<number, number>;
  /** A resize may show rows before their images arrive; nothing else may. */
  holeAllowed: boolean;
}

interface World {
  s: Scheduler;
  env: Env;
}

/** The Scheduler's fields, as the checker copies them. A new field must be added here. */
const FIELDS = [
  "actions", "awaitingFreshSync", "capturing", "dirty", "direction", "editStartedAt", "failedKeys", "failure", "follow",
  "geometry", "images", "latencyMs", "marks", "next", "nextId", "pendingTop", "shown",
  "syncing", "top",
].sort();

type Fields = Record<string, unknown> & {
  images: Map<string, { id: number; bytes: number; image: unknown }>;
  failedKeys: Set<string>;
  marks: Map<string, number>;
  actions: Action[];
};

function fieldsOf(s: Scheduler): Fields {
  return s as unknown as Fields;
}

function cloneScheduler(s: Scheduler): Scheduler {
  const keys = Object.keys(s).sort();
  if (keys.join() !== FIELDS.join()) {
    throw new Error(`Scheduler fields changed (${keys.join(", ")}); update FIELDS, cloneScheduler and stateKey`);
  }
  const from = fieldsOf(s);
  const to = Object.create(Scheduler.prototype) as Fields;
  for (const k of keys) to[k] = from[k];
  to.images = new Map([...from.images].map(([k, e]) => [k, { ...e }]));
  to.failedKeys = new Set(from.failedKeys);
  to.marks = new Map(from.marks);
  to.actions = [...from.actions];
  return to as unknown as Scheduler;
}

function clone(w: World): World {
  return { s: cloneScheduler(w.s), env: { ...w.env, terminal: new Map(w.env.terminal) } };
}

const layoutNames = new WeakMap<Layout, string>();
function layoutName(l: Layout | null): string {
  if (!l) return "-";
  let name = layoutNames.get(l);
  if (!name) {
    name = `${l.raster.contentCols}:${l.blockKeys.join(",")}`;
    layoutNames.set(l, name);
  }
  return name;
}

/**
 * Identifies a state up to renaming of image ids, which the scheduler only compares and
 * allocates fresh. Marks, latency and the clock are left out: they only feed the status line
 * and the wake-up time, never a decision.
 */
function stateKey(w: World): string {
  const f = fieldsOf(w.s);
  const ids = new Set<number>();
  for (const e of f.images.values()) ids.add(e.id);
  for (const id of w.env.terminal.keys()) ids.add(id);
  if (w.env.capture) ids.add(w.env.capture.id);
  const rank = new Map([...ids].sort((a, b) => a - b).map((id, i) => [id, i]));
  return JSON.stringify([
    w.env.doc,
    w.env.screen,
    w.env.sync?.screen ?? -1,
    w.env.capture ? [w.env.capture.imageKey, rank.get(w.env.capture.id)] : null,
    [...w.env.terminal].map(([id, b]) => [rank.get(id), b]).sort(),
    w.env.holeAllowed,
    layoutName(f.shown as Layout | null),
    layoutName(f.next as Layout | null),
    SCREENS.indexOf(f.geometry as Geometry),
    f.top, f.pendingTop, f.follow, f.direction, f.dirty, f.syncing, f.capturing, f.awaitingFreshSync, f.failure,
    [...f.failedKeys].sort(),
    [...f.images].map(([k, e]) => [k, rank.get(e.id), e.bytes, e.image !== null]).sort(),
  ]);
}

class Violation extends Error {}

function covered(w: World): boolean {
  const v = w.s.view();
  if (!v.shown) return true;
  for (const key of visibleImageKeys(v.shown, v.top, v.geometry.viewRows)) if (!v.images.has(key)) return false;
  return true;
}

function residentIds(w: World): Set<number> {
  return new Set([...w.s.view().images.values()].map((i) => i.id));
}

function perform(w: World, actions: Action[]): void {
  for (const a of actions) {
    switch (a.type) {
      case "sync":
        if (w.env.sync) throw new Violation("a second sync was started while one was in flight");
        w.env.sync = { screen: w.env.screen };
        break;
      case "capture":
        if (w.env.capture) throw new Violation("a second capture was started while one was in flight");
        if (w.env.terminal.has(a.id)) throw new Violation(`capture reused id ${a.id}, which the terminal still holds`);
        w.env.capture = a;
        break;
      case "evict":
        for (const id of a.ids) {
          if (!w.env.terminal.has(id)) throw new Violation(`evicted id ${id}, which the terminal does not hold`);
          w.env.terminal.delete(id);
        }
        break;
      case "resetPage":
        break;
    }
  }
}

/** Bytes the slices visible in these screens can take, each slice counted once. */
function screensBytes(screens: { layout: Layout; top: number }[], viewRows: number): number {
  const slices = new Map<string, number>();
  for (const { layout, top } of screens) {
    for (const key of visibleImageKeys(layout, top, viewRows)) slices.set(key, layout.slices.get(key)!.maxBytes);
  }
  return [...slices.values()].reduce((a, b) => a + b, 0);
}

/** The old screen and the target do not fit in storage together, so the old one may give way. */
function crowded(w: World): boolean {
  const v = w.s.view();
  if (!v.shown || !v.target) return false;
  return screensBytes([{ layout: v.shown, top: v.top }, v.target], v.geometry.viewRows) > v.geometry.storageBytes;
}

function dispatch(w: World, event: SchedulerEvent): void {
  const before = w.s.view();
  const step = w.s.dispatch(event);
  const after = w.s.view();
  if (after.shown) {
    const showing = new Map([...visibleImageKeys(after.shown, after.top, after.geometry.viewRows)].map((k) => [before.images.get(k)?.id, k]));
    for (const a of step.actions) {
      if (a.type !== "evict") continue;
      for (const id of a.ids) {
        if (!showing.has(id)) continue;
        if (!crowded(w)) throw new Violation(`evicted ${showing.get(id)}, which stays on screen, though the old screen and the target fit together`);
        w.env.holeAllowed = true;
      }
    }
  }
  perform(w, step.actions);
  if (event.type === "resize") w.env.holeAllowed = true;
  if (covered(w)) w.env.holeAllowed = false;
}

function checkState(w: World): void {
  if (!w.env.holeAllowed && !covered(w)) throw new Violation("the screen shows a block whose image is not in the terminal");
  const v = w.s.view();
  const status = v.status;
  const idle = !w.env.sync && !w.env.capture;
  if (idle && (status === "scrolling" || status === "updating" || status === "rendering")) {
    throw new Violation(`nothing is in flight, yet the status says "${status}": that work never happens`);
  }
  if (idle && v.shown && !covered(w)) {
    const failed = fieldsOf(w.s).failedKeys;
    const visible = visibleImageKeys(v.shown, v.top, v.geometry.viewRows);
    const tooBig = screensBytes([{ layout: v.shown, top: v.top }], v.geometry.viewRows) > v.geometry.storageBytes;
    if (!tooBig && ![...visible].some((k) => !v.images.has(k) && failed.has(k))) {
      throw new Violation("nothing is in flight, yet a block on screen has no image: the hole is never filled");
    }
  }
  const g = w.s.view().geometry;
  let used = 0;
  for (const b of w.env.terminal.values()) used += b;
  if (w.env.capture) used += g.imgWidthPx * maxSliceImagePx(w.env.capture.ref.lengthCss, g.raster) * 4;
  if (used > g.storageBytes) throw new Violation(`terminal storage exceeded: ${used} > ${g.storageBytes} bytes`);
  const resident = residentIds(w);
  const held = [...w.env.terminal.keys()];
  if (held.length !== resident.size || held.some((id) => !resident.has(id))) {
    throw new Violation(`terminal holds ids [${held.sort()}] but the scheduler thinks [${[...resident].sort()}]`);
  }
}

interface Move {
  label: string;
  apply(w: World): void;
}

function moves(w: World): Move[] {
  const out: Move[] = [];
  const at = 0;
  DOCS.forEach((doc, i) =>
    out.push({
      label: `save doc ${i} [${doc.map((s) => s.key).join(" ")}]`,
      apply: (x) => {
        x.env.doc = i;
        dispatch(x, { type: "fileChanged", at });
      },
    }),
  );
  if (w.env.sync) {
    const asked = w.env.sync.screen;
    const answers = new Set([asked, w.env.screen]);
    for (const screenIndex of answers) {
      out.push({
        label: `page answers the sync with the current doc at screen ${screenIndex}`,
        apply: (x) => {
          x.env.sync = null;
          dispatch(x, { type: "synced", layout: synced(DOCS[x.env.doc]!, SCREENS[screenIndex]!), at });
        },
      });
    }
    out.push({
      label: "page fails the sync",
      apply: (x) => {
        x.env.sync = null;
        dispatch(x, { type: "syncFailed", at });
      },
    });
  }
  if (w.env.capture) {
    const c = w.env.capture;
    out.push({
      label: `page delivers ${c.imageKey} as id ${c.id}`,
      apply: (x) => {
        const g = SCREENS[x.env.screen]!;
        const heightImgPx = maxSliceImagePx(c.ref.lengthCss, g.raster);
        x.env.capture = null;
        x.env.terminal.set(c.id, g.imgWidthPx * heightImgPx * 4);
        dispatch(x, { type: "captured", imageKey: c.imageKey, id: c.id, image: { contentTopImgPx: 30, heightImgPx }, at });
      },
    });
    for (const gone of [true, false]) {
      out.push({
        label: `page fails ${c.imageKey} (${gone ? "blocks moved" : "content error"})`,
        apply: (x) => {
          x.env.capture = null;
          dispatch(x, { type: "captureFailed", imageKey: c.imageKey, id: c.id, gone, at });
        },
      });
    }
  }
  for (const delta of KEYS) {
    out.push({ label: `key ${JSON.stringify(delta)}`, apply: (x) => dispatch(x, { type: "key", delta, at }) });
  }
  SCREENS.forEach((g, i) => {
    if (i === w.env.screen) return;
    out.push({
      label: `resize to screen ${i} (${g.cols}x${g.rows})`,
      apply: (x) => {
        x.env.screen = i;
        dispatch(x, { type: "resize", geometry: g, at });
      },
    });
  });
  out.push({ label: "Ctrl-R", apply: (x) => dispatch(x, { type: "hardRefresh", at }) });
  return out;
}

/** Liveness: after one more save, answering everything without failure shows the current doc. */
function converges(start: World): string | null {
  const w = clone(start);
  dispatch(w, { type: "fileChanged", at: 0 });
  for (let i = 0; i < 400; i++) {
    checkState(w);
    if (w.env.sync) {
      const screenIndex = w.env.screen;
      w.env.sync = null;
      dispatch(w, { type: "synced", layout: synced(DOCS[w.env.doc]!, SCREENS[screenIndex]!), at: 0 });
    } else if (w.env.capture) {
      const c = w.env.capture;
      const g = SCREENS[w.env.screen]!;
      const heightImgPx = maxSliceImagePx(c.ref.lengthCss, g.raster);
      w.env.capture = null;
      w.env.terminal.set(c.id, g.imgWidthPx * heightImgPx * 4);
      dispatch(w, { type: "captured", imageKey: c.imageKey, id: c.id, image: { contentTopImgPx: 30, heightImgPx }, at: 0 });
    } else break;
  }
  const v = w.s.view();
  const want = DOCS[w.env.doc]!.map((s) => s.key).join(" ");
  const got = v.shown?.blockKeys.join(" ") ?? "(nothing)";
  if (w.env.sync || w.env.capture) return `still busy after 400 answers`;
  if (got !== want) return `shows [${got}] instead of [${want}] (status: ${v.status})`;
  if (!covered(w)) return "the final screen has a hole";
  if (v.status !== "idle") return `ends with status "${v.status}"`;
  return null;
}

function check(storage: Storage, maxDepth: number): void {
  SCREENS = [screen(40, 7, storage), screen(40, 10, storage), screen(50, 7, storage)];
  const liveness = storage === "roomy";
  const started = performance.now();
  console.log(`storage "${storage}" (${STORAGE[storage]} slices${liveness ? ", updates must get through" : ""}):`);

  const initial: World = {
    s: new Scheduler(SCREENS[0]!),
    env: { doc: 0, screen: 0, sync: null, capture: null, terminal: new Map(), holeAllowed: false },
  };
  dispatch(initial, { type: "fileChanged", at: 0 });

  const parents = new Map<string, { parent: string | null; label: string }>();
  const rootKey = stateKey(initial);
  parents.set(rootKey, { parent: null, label: "start: the file holds doc 0, mdpx dispatches its first save" });
  let frontier: { key: string; w: World }[] = [{ key: rootKey, w: initial }];
  let transitions = 0;

  const trace = (key: string): string[] => {
    const steps: string[] = [];
    for (let k: string | null = key; k; k = parents.get(k)!.parent) steps.push(parents.get(k)!.label);
    return steps.reverse();
  };
  const fail = (key: string, label: string, message: string): never => {
    console.error(`VIOLATION (storage "${storage}"): ${message}\n\nShortest path:`);
    [...trace(key), label].forEach((s, i) => console.error(`  ${String(i + 1).padStart(2)}. ${s}`));
    process.exit(1);
  };

  const live = liveness && converges(initial);
  if (live) fail(rootKey, "(one more save, then every request answered)", `does not converge: ${live}`);

  for (let depth = 1; depth <= maxDepth && frontier.length; depth++) {
    const next: typeof frontier = [];
    for (const { key, w } of frontier) {
      for (const move of moves(w)) {
        transitions++;
        const x = clone(w);
        try {
          move.apply(x);
          checkState(x);
        } catch (e) {
          if (e instanceof Violation) fail(key, move.label, e.message);
          throw e;
        }
        const k = stateKey(x);
        if (parents.has(k)) continue;
        parents.set(k, { parent: key, label: move.label });
        const notLive = liveness && converges(x);
        if (notLive) fail(k, "(one more save, then every request answered)", `does not converge: ${notLive}`);
        next.push({ key: k, w: x });
      }
    }
    frontier = next;
    console.log(`depth ${String(depth).padStart(2)}: ${String(parents.size).padStart(8)} states, ${next.length} new`);
  }
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  const complete = frontier.length === 0 ? "the whole reachable state space" : `all paths up to ${maxDepth} events`;
  console.log(`ok: ${parents.size} states, ${transitions} transitions, ${complete}, ${seconds}s`);
}

const depthArg = process.argv.indexOf("--depth");
const maxDepth = depthArg > 0 ? Number(process.argv[depthArg + 1]) : 8;
for (const storage of Object.keys(STORAGE) as Storage[]) check(storage, maxDepth);
