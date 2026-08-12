import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  maxResident: 64,
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
