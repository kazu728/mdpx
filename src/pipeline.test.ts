import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((r) => (resolve = r)), resolve };
}

const settle = () => new Promise((r) => setImmediate(r));

async function harness() {
  const dir = await mkdtemp(join(tmpdir(), "mdpx-pipeline-"));
  const mdPath = join(dir, "a.md");
  await writeFile(mdPath, "# a\n");

  const calls: string[] = [];
  const loadCalled = deferred<void>();
  const loadResult = deferred<number>();
  const chrome = {
    load: () => {
      calls.push("load");
      loadCalled.resolve();
      return loadResult.promise;
    },
    collectAnchors: async () => [],
    shoot: async () => {
      calls.push("shoot");
      return "";
    },
    restart: async () => {},
  };
  const pipeline = new Pipeline({
    chrome,
    scheduler: new Scheduler(GEO),
    term: { write: () => {} },
    mdPath,
    mdDir: dir,
    fileName: "a.md",
    htmlPath: join(dir, "view.html"),
    assets: { light: resolveAssets("light"), dark: resolveAssets("dark") },
    isShuttingDown: () => false,
    onFatal: async () => {
      throw new Error("unexpected fatal");
    },
  });
  return { pipeline, calls, loadCalled, loadResult };
}

describe("redraw dedup", () => {
  test("identical consecutive frames reach the terminal once", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mdpx-pipeline-dedup-"));
    const mdPath = join(dir, "a.md");
    await writeFile(mdPath, "# a\n");
    const writes: string[] = [];
    const scheduler = new Scheduler({ ...GEO, cols: 80 });
    const pipeline = new Pipeline({
      chrome: {
        load: async () => 1000,
        collectAnchors: async () => [],
        shoot: async () => "",
        restart: async () => {},
      },
      scheduler,
      term: {
        write: (s: string) => {
          writes.push(s);
        },
      },
      mdPath,
      mdDir: dir,
      fileName: "a.md",
      htmlPath: join(dir, "view.html"),
      assets: { light: resolveAssets("light"), dark: resolveAssets("dark") },
      isShuttingDown: () => true,
      onFatal: async () => {
        throw new Error("unexpected fatal");
      },
    });
    pipeline.execute([{ type: "redraw" }]);
    pipeline.execute([{ type: "redraw" }]);
    expect(writes.length).toBe(1);
    // A state change still redraws; the in-flight render is dropped at shutdown.
    pipeline.execute(scheduler.dispatch({ type: "trigger" }));
    expect(writes.length).toBe(2);
    for (let i = 0; i < 50; i++) await settle();
    expect(writes.length).toBe(2);
  });
});

describe("one page at a time", () => {
  test("a capture waits for the load in flight instead of racing the navigation", async () => {
    const { pipeline, calls, loadCalled, loadResult } = await harness();

    pipeline.execute([{ type: "render", gen: 1 }]);
    await loadCalled.promise;

    pipeline.execute([
      {
        type: "shoot",
        gen: 1,
        tileIndex: 0,
        clip: { xCssPx: 0, yCssPx: 0, widthCssPx: 100, heightCssPx: 250 },
      },
    ]);
    await settle();
    expect(calls).toEqual(["load"]);

    loadResult.resolve(1000);
    await settle();
    expect(calls).toEqual(["load", "shoot"]);
  });
});

describe("generation binding", () => {
  test("a failed update reloads the displayed document before old tiles are shot again", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mdpx-pipeline-gen-"));
    const mdPath = join(dir, "a.md");
    await writeFile(mdPath, "# a\n");
    const scheduler = new Scheduler(GEO);
    const loads: string[] = [];
    let shoots = 0;
    const chrome = {
      load: (htmlPath: string) => {
        loads.push(htmlPath);
        if (htmlPath.includes("gen-2")) throw new ContentError("load timed out");
        return Promise.resolve(1000);
      },
      collectAnchors: async () => [],
      shoot: async () => {
        shoots += 1;
        return "";
      },
      restart: async () => {},
    };
    const pipeline = new Pipeline({
      chrome,
      scheduler,
      term: { write: () => {} },
      mdPath,
      mdDir: dir,
      fileName: "a.md",
      htmlPath: join(dir, "view.html"),
      assets: { light: resolveAssets("light"), dark: resolveAssets("dark") },
      isShuttingDown: () => false,
      onFatal: async () => {
        throw new Error("unexpected fatal");
      },
    });

    pipeline.execute(scheduler.dispatch({ type: "trigger" }));
    for (let i = 0; i < 500 && scheduler.viewState().displayGen !== 1; i++) {
      await settle();
    }
    expect(scheduler.viewState().displayGen).toBe(1);
    const loadsAfterGen1 = loads.length;
    expect(loadsAfterGen1).toBeGreaterThan(0);

    // Failure keeps the display with no eager restore; the next old-gen shoot reloads lazily.
    pipeline.execute(scheduler.dispatch({ type: "trigger" }));
    for (let i = 0; i < 500 && !loads.some((p) => p.includes("gen-2")); i++) await settle();
    for (let i = 0; i < 500; i++) await settle();
    expect(scheduler.viewState().displayGen).toBe(1);
    expect(loads.some((p) => p.includes("gen-2"))).toBe(true);
    expect(loads.length).toBeGreaterThan(loadsAfterGen1);
    expect(loads.filter((p) => p.includes("gen-1")).length).toBe(loadsAfterGen1);

    const shootsBefore = shoots;
    pipeline.execute([
      {
        type: "shoot",
        gen: 1,
        tileIndex: 0,
        clip: { xCssPx: 0, yCssPx: 0, widthCssPx: 100, heightCssPx: 250 },
      },
    ]);
    for (let i = 0; i < 50; i++) await settle();
    expect(shoots).toBe(shootsBefore + 1);
    expect(scheduler.viewState().displayGen).toBe(1);
    expect(loads.filter((p) => p.includes("gen-1")).length).toBe(loadsAfterGen1 + 1);
  });
});

describe("generation-owned files", () => {
  async function genHarness() {
    const dir = await mkdtemp(join(tmpdir(), "mdpx-pipeline-files-"));
    const mdPath = join(dir, "a.md");
    await writeFile(mdPath, "# a\n");
    const scheduler = new Scheduler(GEO);
    const chrome = {
      load: async () => 1000,
      collectAnchors: async () => [],
      shoot: async () => "",
      restart: async () => {},
    };
    const pipeline = new Pipeline({
      chrome,
      scheduler,
      term: { write: () => {} },
      mdPath,
      mdDir: dir,
      fileName: "a.md",
      htmlPath: join(dir, "view.html"),
      assets: { light: resolveAssets("light"), dark: resolveAssets("dark") },
      isShuttingDown: () => false,
      onFatal: async () => {
        throw new Error("unexpected fatal");
      },
    });
    return { dir, scheduler, pipeline, htmlPath: join(dir, "view.html") };
  }

  async function waitForDisplay(
    scheduler: Scheduler,
    gen: number,
    timeout = 500,
  ): Promise<void> {
    for (let i = 0; i < timeout && scheduler.viewState().displayGen !== gen; i++) {
      await settle();
    }
    expect(scheduler.viewState().displayGen).toBe(gen);
  }

  async function exists(path: string): Promise<boolean> {
    try {
      const { stat } = await import("node:fs/promises");
      await stat(path);
      return true;
    } catch {
      return false;
    }
  }

  test("switching display releases the old HTML and map without waiting for the next load", async () => {
    const { scheduler, pipeline, htmlPath } = await genHarness();
    pipeline.execute(scheduler.dispatch({ type: "trigger" }));
    await waitForDisplay(scheduler, 1);
    expect(await exists(`${htmlPath}.gen-1.html`)).toBe(true);

    pipeline.execute(scheduler.dispatch({ type: "trigger" }));
    await waitForDisplay(scheduler, 2);
    // Old generation ends at promotion: its file and map are gone even though gen 3 never loads.
    for (let i = 0; i < 100; i++) await settle();
    expect(await exists(`${htmlPath}.gen-1.html`)).toBe(false);
    expect(await exists(`${htmlPath}.gen-2.html`)).toBe(true);
    const maps = (pipeline as unknown as { lineMaps: Map<number, unknown> }).lineMaps;
    expect(maps.has(1)).toBe(false);
    expect(maps.has(2)).toBe(true);
  });

  test("a failed generation releases its file while the displayed generation keeps its own", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mdpx-pipeline-fail-"));
    const mdPath = join(dir, "a.md");
    await writeFile(mdPath, "# a\n");
    const scheduler = new Scheduler(GEO);
    const chrome = {
      load: (p: string) => {
        if (p.includes("gen-2")) throw new ContentError("load timed out");
        return Promise.resolve(1000);
      },
      collectAnchors: async () => [],
      shoot: async () => "",
      restart: async () => {},
    };
    const htmlPath = join(dir, "view.html");
    const pipeline = new Pipeline({
      chrome,
      scheduler,
      term: { write: () => {} },
      mdPath,
      mdDir: dir,
      fileName: "a.md",
      htmlPath,
      assets: { light: resolveAssets("light"), dark: resolveAssets("dark") },
      isShuttingDown: () => false,
      onFatal: async () => {
        throw new Error("unexpected fatal");
      },
    });
    pipeline.execute(scheduler.dispatch({ type: "trigger" }));
    await waitForDisplay(scheduler, 1);
    expect(await exists(`${htmlPath}.gen-1.html`)).toBe(true);

    pipeline.execute(scheduler.dispatch({ type: "trigger" }));
    for (let i = 0; i < 500; i++) await settle();
    expect(scheduler.viewState().displayGen).toBe(1);
    expect(await exists(`${htmlPath}.gen-1.html`)).toBe(true);
    expect(await exists(`${htmlPath}.gen-2.html`)).toBe(false);
    const maps = (pipeline as unknown as { lineMaps: Map<number, unknown> }).lineMaps;
    expect(maps.has(1)).toBe(true);
    expect(maps.has(2)).toBe(false);
  });
});
