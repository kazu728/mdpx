import { describe, expect, test } from "bun:test";
import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContentError } from "./chrome.ts";
import { resolveAssets } from "./html.ts";
import { Pipeline, type ScrollInfo } from "./pipeline.ts";
import { Scheduler } from "./scheduler.ts";
import { ScrollTracker } from "./sync/tracker.ts";
import { alignedTileHeightPx, CSS_SCALE } from "./viewport.ts";
import type { Geometry } from "./geometry.ts";

const GEO: Geometry = {
  rows: 51,
  cols: 10,
  cellHpx: 10,
  imgWidthPx: 200,
  viewportWidthCssPx: 100,
  renderScale: 2,
  tileHeightPx: alignedTileHeightPx(10, 50),
  exceedsFrameLimit: false,
  exceedsStorage: false,
  maxResident: 64,
  maxTotalResident: 128,
};

const settle = () => new Promise((r) => setImmediate(r));
const waitFor = async (cond: () => boolean, n = 500) => {
  for (let i = 0; i < n && !cond(); i++) await settle();
};
const exists = async (p: string) => {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
};
function deferred<T>() {
  let resolve!: (v: T) => void;
  return { promise: new Promise<T>((r) => (resolve = r)), resolve };
}
const baseChrome = () => ({
  load: async () => 1000,
  collectAnchors: async () => [],
  shoot: async () => "",
});
async function makePipeline(chrome: unknown, opts?: { cols?: number; write?: (s: string) => void; shuttingDown?: boolean; tracker?: ScrollTracker; onScroll?: (info: ScrollInfo) => void; md?: string }) {
  const dir = await mkdtemp(join(tmpdir(), "mdpx-pipeline-"));
  const mdPath = join(dir, "a.md");
  await writeFile(mdPath, opts?.md ?? "# a\n");
  const scheduler = new Scheduler(opts?.cols ? { ...GEO, cols: opts.cols } : GEO);
  const htmlPath = join(dir, "view.html");
  const shuttingDown = opts?.shuttingDown ?? false;
  const tracker = opts?.tracker;
  const pipeline = new Pipeline({
    chrome: chrome as never,
    scheduler,
    term: { write: opts?.write ?? (() => {}) },
    ...(tracker
      ? {
          onFrameMapped: (gen, meta) => tracker.setFrame(gen, meta),
          onFrameReleased: (gen) => tracker.releaseFrame(gen),
        }
      : {}),
    ...(opts?.onScroll ? { onScroll: opts.onScroll } : {}),
    mdPath,
    mdDir: dir,
    fileName: "a.md",
    htmlPath,
    assets: { light: resolveAssets("light"), dark: resolveAssets("dark") },
    isShuttingDown: () => shuttingDown,
    onFatal: async () => {
      throw new Error("unexpected fatal");
    },
  });
  return { dir, scheduler, pipeline, htmlPath };
}

describe("redraw dedup", () => {
  test("identical frames reach terminal once", async () => {
    const writes: string[] = [];
    const { scheduler, pipeline } = await makePipeline(baseChrome(), {
      cols: 80,
      write: (s) => writes.push(s),
      shuttingDown: true,
    });
    pipeline.execute([{ type: "redraw" }]);
    pipeline.execute([{ type: "redraw" }]);
    expect(writes.length).toBe(1);
    pipeline.execute(scheduler.dispatch({ type: "trigger" }));
    expect(writes.length).toBe(2);
    for (let i = 0; i < 50; i++) await settle();
    expect(writes.length).toBe(2);
  });
});

describe("one page at a time", () => {
  test("capture waits for load in flight", async () => {
    const calls: string[] = [];
    const loadCalled = deferred<void>();
    const loadResult = deferred<number>();
    const { pipeline } = await makePipeline({
      ...baseChrome(),
      load: () => {
        calls.push("load");
        loadCalled.resolve();
        return loadResult.promise;
      },
      shoot: async () => {
        calls.push("shoot");
        return "";
      },
    });
    pipeline.execute([{ type: "render", gen: 1 }]);
    await loadCalled.promise;
    pipeline.execute([
      { type: "shoot", gen: 1, tileIndex: 0, clip: { xCssPx: 0, yCssPx: 0, widthCssPx: 100, heightCssPx: 250 } },
    ]);
    await settle();
    expect(calls).toEqual(["load"]);
    loadResult.resolve(1000);
    await settle();
    expect(calls).toEqual(["load", "shoot"]);
  });
});

describe("generation binding", () => {
  test("failed update reloads display before old tiles re-shoot", async () => {
    const loads: string[] = [];
    let shoots = 0;
    const { scheduler, pipeline } = await makePipeline({
      ...baseChrome(),
      load: (p: string) => {
        loads.push(p);
        if (p.includes("gen-2")) throw new ContentError("load timed out");
        return Promise.resolve(1000);
      },
      shoot: async () => {
        shoots += 1;
        return "";
      },
    });
    pipeline.execute(scheduler.dispatch({ type: "trigger" }));
    await waitFor(() => scheduler.viewState().displayGen === 1);
    expect(scheduler.viewState().displayGen).toBe(1);
    const afterGen1 = loads.length;
    expect(afterGen1).toBeGreaterThan(0);
    pipeline.execute(scheduler.dispatch({ type: "trigger" }));
    await waitFor(() => loads.some((p) => p.includes("gen-2")));
    for (let i = 0; i < 500; i++) await settle();
    expect(scheduler.viewState().displayGen).toBe(1);
    expect(loads.length).toBeGreaterThan(afterGen1);
    expect(loads.filter((p) => p.includes("gen-1")).length).toBe(afterGen1);
    const before = shoots;
    pipeline.execute([
      { type: "shoot", gen: 1, tileIndex: 0, clip: { xCssPx: 0, yCssPx: 0, widthCssPx: 100, heightCssPx: 250 } },
    ]);
    for (let i = 0; i < 50; i++) await settle();
    expect(shoots).toBe(before + 1);
    expect(loads.filter((p) => p.includes("gen-1")).length).toBe(afterGen1 + 1);
  });
});

describe("generation-owned files", () => {
  test("switching releases old HTML and map at promotion", async () => {
    const tracker = new ScrollTracker();
    const { scheduler, pipeline, htmlPath } = await makePipeline(baseChrome(), { tracker });
    pipeline.execute(scheduler.dispatch({ type: "trigger" }));
    await waitFor(() => scheduler.viewState().displayGen === 1);
    expect(await exists(`${htmlPath}.gen-1.html`)).toBe(true);
    expect(
      tracker.displayedSourceLine({ displayGen: 1, scrollPx: 0, jumpToEnd: false }),
    ).not.toBeNull();
    pipeline.execute(scheduler.dispatch({ type: "trigger" }));
    await waitFor(() => scheduler.viewState().displayGen === 2);
    for (let i = 0; i < 100; i++) await settle();
    expect(await exists(`${htmlPath}.gen-1.html`)).toBe(false);
    expect(await exists(`${htmlPath}.gen-2.html`)).toBe(true);
    expect(
      tracker.displayedSourceLine({ displayGen: 1, scrollPx: 0, jumpToEnd: false }),
    ).toBeNull();
    expect(
      tracker.displayedSourceLine({ displayGen: 2, scrollPx: 0, jumpToEnd: false }),
    ).not.toBeNull();
  });
});

describe("frame observers", () => {
  test("mapped frames and scroll commits reach observers", async () => {
    const tracker = new ScrollTracker();
    const seen: ScrollInfo[] = [];
    const { scheduler, pipeline } = await makePipeline(
      {
        ...baseChrome(),
        collectAnchors: async () => [{ sourceLine: 3, topCssPx: 500 }],
      },
      { tracker, onScroll: (info) => seen.push(info), md: "# a\n\nline three\n" },
    );
    pipeline.execute(scheduler.dispatch({ type: "trigger" }));
    await waitFor(() => scheduler.viewState().displayGen === 1);
    expect(
      tracker.displayedSourceLine({ displayGen: 1, scrollPx: 0, jumpToEnd: false }),
    ).not.toBeNull();
    pipeline.execute([{ type: "scrollCommitted", jumpToEnd: false }]);
    expect(seen.length).toBe(1);
    expect(seen[0]!.displayGen).toBe(1);
    expect(tracker.displayedSourceLine({ ...seen[0]!, scrollPx: 500 * CSS_SCALE })).toBe(3);
  });

  test("core without observers skips anchor collection and notifies nobody", async () => {
    let anchorsCollected = 0;
    const { scheduler, pipeline } = await makePipeline(
      {
        ...baseChrome(),
        collectAnchors: async () => {
          anchorsCollected += 1;
          return [];
        },
      },
    );
    pipeline.execute(scheduler.dispatch({ type: "trigger" }));
    await waitFor(() => scheduler.viewState().displayGen === 1);
    expect(anchorsCollected).toBe(0);
    pipeline.execute([{ type: "scrollCommitted", jumpToEnd: false }]);
  });
});

describe("late images", () => {
  test("no re-render is triggered after display; stragglers wait for the next save", async () => {
    const loads: string[] = [];
    const { scheduler, pipeline } = await makePipeline({
      ...baseChrome(),
      load: (p: string) => {
        loads.push(p);
        return Promise.resolve(1000);
      },
    });
    pipeline.execute(scheduler.dispatch({ type: "trigger" }));
    await waitFor(() => scheduler.viewState().displayGen === 1);
    expect(scheduler.viewState().displayGen).toBe(1);
    const after = loads.length;
    for (let i = 0; i < 100; i++) await settle();
    expect(loads.length).toBe(after);
  });
});
