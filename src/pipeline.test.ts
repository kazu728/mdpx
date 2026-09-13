import { describe, expect, test } from "bun:test";
import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContentError } from "./chrome.ts";
import { resolveAssets } from "./html.ts";
import { Pipeline } from "./pipeline.ts";
import { Scheduler } from "./scheduler.ts";
import { alignedTileHeightPx } from "./viewport.ts";
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
  restart: async () => {},
  imagesPending: async () => false,
  waitForLateImages: async () => {},
});
async function makePipeline(chrome: unknown, opts?: { cols?: number; write?: (s: string) => void; shuttingDown?: boolean }) {
  const dir = await mkdtemp(join(tmpdir(), "mdpx-pipeline-"));
  const mdPath = join(dir, "a.md");
  await writeFile(mdPath, "# a\n");
  const scheduler = new Scheduler(opts?.cols ? { ...GEO, cols: opts.cols } : GEO);
  const htmlPath = join(dir, "view.html");
  const shuttingDown = opts?.shuttingDown ?? false;
  const pipeline = new Pipeline({
    chrome: chrome as never,
    scheduler,
    term: { write: opts?.write ?? (() => {}) },
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
    const { scheduler, pipeline, htmlPath } = await makePipeline(baseChrome());
    pipeline.execute(scheduler.dispatch({ type: "trigger" }));
    await waitFor(() => scheduler.viewState().displayGen === 1);
    expect(await exists(`${htmlPath}.gen-1.html`)).toBe(true);
    pipeline.execute(scheduler.dispatch({ type: "trigger" }));
    await waitFor(() => scheduler.viewState().displayGen === 2);
    for (let i = 0; i < 100; i++) await settle();
    expect(await exists(`${htmlPath}.gen-1.html`)).toBe(false);
    expect(await exists(`${htmlPath}.gen-2.html`)).toBe(true);
    const maps = (pipeline as unknown as { lineMaps: Map<number, unknown> }).lineMaps;
    expect(maps.has(1)).toBe(false);
    expect(maps.has(2)).toBe(true);
  });
});

describe("late images", () => {
  test("image finishing after display triggers one re-render", async () => {
    const loads: string[] = [];
    let pending = true;
    const { scheduler, pipeline } = await makePipeline({
      ...baseChrome(),
      load: (p: string) => {
        loads.push(p);
        return Promise.resolve(1000);
      },
      imagesPending: async () => pending,
      waitForLateImages: async () => {
        pending = false;
      },
    });
    pipeline.execute(scheduler.dispatch({ type: "trigger" }));
    await waitFor(() => scheduler.viewState().displayGen === 2);
    expect(scheduler.viewState().displayGen).toBe(2);
    expect(loads.some((p) => p.includes("gen-2"))).toBe(true);
    const after = loads.length;
    for (let i = 0; i < 100; i++) await settle();
    expect(loads.length).toBe(after);
  });
});
