import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContentError } from "./chrome.ts";
import { resolveAssets } from "./html.ts";
import { Pipeline } from "./pipeline.ts";
import { Scheduler, type SchedulerEvent } from "./scheduler.ts";
import { GEO } from "./test-geometry.ts";

interface PageCall {
  kind: "load" | "shoot";
  target: unknown;
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

/** Chrome whose page operations complete only when the test settles them. */
function fakeChrome() {
  const unclaimed: PageCall[] = [];
  const waiting: ((call: PageCall) => void)[] = [];
  const call = (kind: PageCall["kind"], target: unknown) =>
    new Promise((resolve, reject) => {
      const c = { kind, target, resolve, reject };
      const take = waiting.shift();
      if (take) take(c);
      else unclaimed.push(c);
    });
  return {
    chrome: {
      load: (htmlPath: string) => call("load", htmlPath) as Promise<number>,
      shoot: (yCssPx: number, heightCssPx: number) => call("shoot", { yCssPx, heightCssPx }) as Promise<string>,
    },
    next: () =>
      new Promise<PageCall>((resolve) => {
        const c = unclaimed.shift();
        if (c) resolve(c);
        else waiting.push(resolve);
      }),
    unclaimed,
  };
}

const flush = () => new Promise((r) => setImmediate(r));
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "mdpx-pipeline-"));
  dirs.push(dir);
  const mdPath = join(dir, "a.md");
  await writeFile(mdPath, "# a\n");
  const page = fakeChrome();
  const writes: string[] = [];
  const fatal: unknown[] = [];
  const state = { shuttingDown: false };
  const scheduler = new Scheduler(GEO);
  const pipeline = new Pipeline({
    chrome: page.chrome,
    scheduler,
    term: { write: (s) => writes.push(s) },
    mdPath,
    htmlDir: dir,
    assets: resolveAssets(),
    isShuttingDown: () => state.shuttingDown,
    onFatal: (error) => {
      fatal.push(error);
      return new Promise<never>(() => {});
    },
  });
  const send = (event: SchedulerEvent) => pipeline.dispatch(event);
  const html = (gen: number) => join(dir, `gen-${gen}.html`);
  // A 250 CSS px document is one GEO tile, so one load and one shoot display a generation.
  const display = async () => {
    send({ type: "trigger" });
    (await page.next()).resolve(250);
    (await page.next()).resolve("");
    await flush();
  };
  return { page, writes, fatal, state, scheduler, pipeline, send, html, display };
}

const shootTile0 = { type: "shoot", gen: 1, tileIndex: 0, tile: { topPx: 0, heightPx: 500 } } as const;

describe("Pipeline", () => {
  test("an unchanged frame is not written again", async () => {
    const t = await setup();
    t.send({ type: "trigger" });
    expect(t.writes).toHaveLength(1);
    // A save during the render coalesces and leaves the frame as it was.
    t.send({ type: "trigger" });
    expect(t.writes).toHaveLength(1);
    await t.page.next();
  });

  test("a tile is captured as its CSS-pixel band of the page", async () => {
    const t = await setup();
    t.pipeline.execute([{ type: "shoot", gen: 1, tileIndex: 1, tile: { topPx: 500, heightPx: 500 } }]);
    (await t.page.next()).resolve(250);
    expect((await t.page.next()).target).toEqual({ yCssPx: 800, heightCssPx: 800 });
  });

  test("a released document survives until the page work queued before its release is done", async () => {
    const t = await setup();
    await t.display();
    t.send({ type: "trigger" });
    const update = await t.page.next();
    t.pipeline.execute([shootTile0]);
    update.reject(new ContentError("load timed out"));
    const reload = await t.page.next();
    expect(reload.target).toBe(t.html(1));

    t.send({ type: "resize", geometry: { ...GEO, rows: 31 } });
    await flush();
    expect(existsSync(t.html(1))).toBe(true);

    reload.resolve(250);
    (await t.page.next()).resolve("");
    expect((await t.page.next()).target).toBe(t.html(3));
    expect(existsSync(t.html(1))).toBe(false);
  });

  test("a Chrome failure that the content did not cause is fatal", async () => {
    const t = await setup();
    t.send({ type: "trigger" });
    const error = new Error("Target closed");
    (await t.page.next()).reject(error);
    await flush();
    expect(t.fatal).toEqual([error]);
  });

  test("nothing is reported back once shutdown has begun", async () => {
    const failed = await setup();
    failed.send({ type: "trigger" });
    const load = await failed.page.next();
    failed.state.shuttingDown = true;
    load.reject(new Error("Target closed"));
    await flush();
    expect(failed.fatal).toEqual([]);

    const loaded = await setup();
    loaded.send({ type: "trigger" });
    const done = await loaded.page.next();
    loaded.state.shuttingDown = true;
    done.resolve(250);
    await flush();
    expect(loaded.page.unclaimed).toEqual([]);
  });

  test("toggling the theme re-renders with the other theme", async () => {
    const t = await setup();
    await t.display();
    t.pipeline.toggleTheme();
    expect((await t.page.next()).target).toBe(t.html(2));
    expect(readFileSync(t.html(2), "utf8")).toContain("github-markdown-dark.css");
  });
});
