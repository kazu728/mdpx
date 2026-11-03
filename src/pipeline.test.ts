import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Geometry } from "./geometry.ts";
import type { CaptureRef, SyncedLayout } from "./layout.ts";
import type { Doc } from "./markdown.ts";
import { CaptureFailed, CaptureGone, type Capture } from "./page.ts";
import { Pipeline, type PageLike } from "./pipeline.ts";
import { Scheduler } from "./scheduler.ts";
import { GEO } from "./test-geometry.ts";

type Call =
  | { kind: "sync"; doc: Doc; geometry: Geometry; resolve(v: SyncedLayout): void; reject(e: unknown): void }
  | { kind: "capture"; ref: CaptureRef; resolve(v: Capture): void; reject(e: unknown): void }
  | { kind: "reset"; resolve(v: void): void; reject(e: unknown): void };

function fakePage() {
  const unclaimed: Call[] = [];
  const waiting: ((c: Call) => void)[] = [];
  const push = (c: Call) => {
    const take = waiting.shift();
    if (take) take(c);
    else unclaimed.push(c);
  };
  const page: PageLike = {
    sync: (doc, geometry) => new Promise((resolve, reject) => push({ kind: "sync", doc, geometry, resolve, reject })),
    capture: (ref) => new Promise((resolve, reject) => push({ kind: "capture", ref, resolve, reject })),
    reset: () => new Promise((resolve, reject) => push({ kind: "reset", resolve, reject })),
  };
  const next = () =>
    new Promise<Call>((resolve) => {
      const c = unclaimed.shift();
      if (c) resolve(c);
      else waiting.push(resolve);
    });
  return { page, next, unclaimed };
}

function layoutFor(doc: Doc, geometry: Geometry): SyncedLayout {
  let y = 32;
  const blocks = doc.blocks.map((b, i) => {
    if (i > 0) y += 16;
    const placed = { key: b.key, kind: b.kind, topCss: y, heightCss: 60 };
    y += 60;
    return placed;
  });
  return { raster: geometry.raster, theme: doc.theme, blocks, docHeightCss: y + 32 };
}

const SHOT: Capture = { pngBase64: "UE5H", contentTopImgPx: 30, heightImgPx: 200 };

const flush = () => new Promise((r) => setImmediate(r));
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function setup(page?: Promise<PageLike>) {
  const dir = await mkdtemp(join(tmpdir(), "mdpx-pipeline-"));
  dirs.push(dir);
  const mdPath = join(dir, "a.md");
  await writeFile(mdPath, "# a\n\nb\n");
  const fake = fakePage();
  const writes: string[] = [];
  const fatal: unknown[] = [];
  const state = { shuttingDown: false };
  let clock = 0;
  const pipeline = new Pipeline({
    page: page ?? Promise.resolve(fake.page),
    scheduler: new Scheduler(GEO),
    term: { write: (s) => writes.push(s) },
    mdPath,
    theme: "light",
    isShuttingDown: () => state.shuttingDown,
    onFatal: (error) => {
      fatal.push(error);
      return new Promise<never>(() => {});
    },
    now: () => (clock += 1),
  });
  const display = async () => {
    pipeline.dispatch({ type: "fileChanged" });
    const sync = await fake.next();
    if (sync.kind !== "sync") throw new Error(`expected a sync, got ${sync.kind}`);
    sync.resolve(layoutFor(sync.doc, sync.geometry));
    for (let i = 0; i < sync.doc.blocks.length; i++) {
      const c = await fake.next();
      if (c.kind !== "capture") throw new Error(`expected a capture, got ${c.kind}`);
      c.resolve(SHOT);
    }
    await flush();
  };
  return { pipeline, fake, writes, fatal, state, mdPath, display };
}

describe("Pipeline", () => {
  test("a save renders the file, syncs the page, transmits each visible slice once and places it", async () => {
    const { pipeline, fake, writes } = await setup();
    pipeline.dispatch({ type: "fileChanged" });
    const sync = await fake.next();
    expect(sync.kind).toBe("sync");
    if (sync.kind !== "sync") return;
    expect(sync.doc.blocks.map((b) => b.kind)).toEqual(["heading", "other"]);
    expect(sync.geometry).toBe(GEO);
    sync.resolve(layoutFor(sync.doc, sync.geometry));
    for (let i = 0; i < 2; i++) {
      const c = await fake.next();
      expect(c.kind).toBe("capture");
      if (c.kind === "capture") c.resolve(SHOT);
    }
    await flush();
    const out = writes.join("");
    expect(out.match(/a=t,f=100/g)).toHaveLength(2);
    expect(out.match(/a=p,/g)?.length).toBeGreaterThanOrEqual(2);
  });

  test("an unchanged frame is not written again", async () => {
    const { pipeline, writes, display } = await setup();
    await display();
    const before = writes.length;
    pipeline.dispatch({ type: "tick" });
    expect(writes.length).toBe(before);
  });

  test("page work waits until Chrome is ready, then runs in order", async () => {
    let ready!: (p: PageLike) => void;
    const { pipeline, fake } = await setup(new Promise<PageLike>((r) => (ready = r)));
    pipeline.dispatch({ type: "fileChanged" });
    await flush();
    expect(fake.unclaimed).toHaveLength(0);
    ready(fake.page);
    expect((await fake.next()).kind).toBe("sync");
  });

  test("a capture refused because the blocks moved re-syncs", async () => {
    const { pipeline, fake } = await setup();
    pipeline.dispatch({ type: "fileChanged" });
    const sync = await fake.next();
    if (sync.kind !== "sync") throw new Error("expected a sync");
    sync.resolve(layoutFor(sync.doc, sync.geometry));
    const capture = await fake.next();
    capture.reject(new CaptureGone());
    expect((await fake.next()).kind).toBe("sync");
  });

  test("a screenshot Chrome could not take is reported and retried on the next save; a Chrome failure is fatal", async () => {
    const shot = await setup();
    shot.pipeline.dispatch({ type: "fileChanged" });
    const sync = await shot.fake.next();
    if (sync.kind !== "sync") throw new Error("expected a sync");
    sync.resolve(layoutFor(sync.doc, sync.geometry));
    (await shot.fake.next()).reject(new CaptureFailed("Unable to capture screenshot"));
    await flush();
    expect(shot.fatal).toEqual([]);
    expect(shot.writes.join("")).toContain("render failed");
    shot.pipeline.dispatch({ type: "fileChanged" });
    expect((await shot.fake.next()).kind).toBe("sync");

    for (const failing of ["sync", "capture"] as const) {
      const crash = await setup();
      crash.pipeline.dispatch({ type: "fileChanged" });
      const boom = new Error("Target closed");
      const first = await crash.fake.next();
      if (failing === "capture") {
        if (first.kind !== "sync") throw new Error("expected a sync");
        first.resolve(layoutFor(first.doc, first.geometry));
        (await crash.fake.next()).reject(boom);
      } else first.reject(boom);
      await flush();
      expect(crash.fatal).toEqual([boom]);
    }
  });

  test("nothing is drawn or transmitted once shutdown has begun", async () => {
    const { pipeline, fake, writes, state } = await setup();
    pipeline.dispatch({ type: "fileChanged" });
    const sync = await fake.next();
    if (sync.kind !== "sync") throw new Error("expected a sync");
    sync.resolve(layoutFor(sync.doc, sync.geometry));
    const capture = await fake.next();
    if (capture.kind !== "capture") throw new Error("expected a capture");
    state.shuttingDown = true;
    const before = writes.length;
    capture.resolve(SHOT);
    await flush();
    pipeline.dispatch({ type: "fileChanged" });
    expect(writes.length).toBe(before);
  });

  test("toggling the theme re-renders with the other theme", async () => {
    const { pipeline, fake, display } = await setup();
    await display();
    pipeline.toggleTheme();
    const sync = await fake.next();
    expect(sync.kind === "sync" && sync.doc.theme).toBe("dark");
  });

  test("an evicted image is deleted in the terminal after the frame that stops placing it", async () => {
    const { pipeline, writes, display } = await setup();
    await display();
    writes.length = 0;
    pipeline.dispatch({ type: "hardRefresh" });
    const out = writes.join("");
    expect(out).toContain("a=d,d=I");
    expect(out.indexOf("a=d,d=I")).toBeGreaterThan(out.indexOf("\x1b[?2026l"));
  });
});
