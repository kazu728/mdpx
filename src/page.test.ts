import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page as BrowserPage } from "puppeteer-core";
import { CELL_CSS_PX, captureGridCss } from "./geometry.ts";
import type { CaptureRef } from "./layout.ts";
import type { Doc } from "./markdown.ts";
import { CaptureFailed, CaptureGone, Page, resolveAssets } from "./page.ts";
import { GEO } from "./test-geometry.ts";

type Rect = { top: number; bottom: number } | null;

class FakeBrowserPage {
  rects: [number, number][] = [];
  rect: Rect = null;
  screenshotError: Error | null = null;
  closed = false;
  connected = true;
  clips: { x: number; y: number; width: number; height: number }[] = [];
  syncCalls: { key: string; html?: string }[][] = [];
  missingOnce: string[] | null = null;
  failNextSync = false;
  runtime = {
    sync: async (blocks: { key: string; html?: string }[]) => {
      this.syncCalls.push(blocks);
      if (this.failNextSync) {
        this.failNextSync = false;
        throw new Error("evaluation failed");
      }
      if (this.missingOnce) {
        const missing = this.missingOnce;
        this.missingOnce = null;
        return { missing };
      }
      return { rects: blocks.map((_, i) => this.rects[i] ?? [i * 50, 40]), docHeight: 1000 };
    },
    rect: () => this.rect,
  };

  async exposeFunction(): Promise<void> {}
  async goto(): Promise<void> {}
  async setViewport(): Promise<void> {}
  async evaluate<A extends unknown[], R>(fn: (...args: A) => R, ...args: A): Promise<Awaited<R>> {
    const global = globalThis as { window?: unknown };
    const saved = global.window;
    global.window = { __mdpx: this.runtime };
    try {
      return await fn(...args);
    } finally {
      global.window = saved;
    }
  }
  async screenshot(options: { clip: { x: number; y: number; width: number; height: number } }): Promise<string> {
    if (this.screenshotError) throw this.screenshotError;
    this.clips.push(options.clip);
    return "UE5H";
  }
  isClosed(): boolean {
    return this.closed;
  }
  browser(): { connected: boolean } {
    return { connected: this.connected };
  }
}

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "mdpx-page-"));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

const doc = (...keys: string[]): Doc => ({
  theme: "light",
  blocks: keys.map((key) => ({ key, html: `<p>${key}</p>` })),
});

async function open(): Promise<{ fake: FakeBrowserPage; page: Page }> {
  const fake = new FakeBrowserPage();
  const page = await Page.open(fake as unknown as BrowserPage, { mdDir: dir, assets: resolveAssets(), dir, onReflow: () => {} });
  return { fake, page };
}

const dsf = GEO.deviceScaleFactor;
const ref = (heightCss: number, offsetCss = 0, lengthCss = heightCss): CaptureRef => ({
  first: { key: "a", occurrence: 0 },
  last: { key: "a", occurrence: 0 },
  runHeightImgPx: Math.round(heightCss * dsf),
  offsetCss,
  lengthCss,
});

describe("Page.capture", () => {
  test("shoots on the capture grid, with at least one row of page around the content", async () => {
    const { fake, page } = await open();
    fake.rects = [[50.5, 40]];
    await page.sync(doc("a"), GEO);
    fake.rect = { top: 50.5, bottom: 90.5 };
    const shot = await page.capture(ref(40));
    const [clip] = fake.clips;
    const grid = captureGridCss(dsf);
    expect(clip!.y % grid).toBe(0);
    expect(clip!.height % grid).toBe(0);
    expect(Number.isInteger(clip!.y * dsf) && Number.isInteger(clip!.height * dsf)).toBe(true);
    expect(clip!.y).toBeLessThanOrEqual(50.5 - CELL_CSS_PX);
    expect(clip!.y + clip!.height).toBeGreaterThanOrEqual(90.5 + CELL_CSS_PX);
    expect(shot.contentTopImgPx).toBe((50.5 - clip!.y) * dsf);
    expect(shot.heightImgPx).toBe(Math.round(clip!.height * dsf));
  });

  test("refuses when the blocks are gone or no longer as tall as they were laid out", async () => {
    const { fake, page } = await open();
    fake.rects = [[50, 40]];
    await page.sync(doc("a"), GEO);
    fake.rect = null;
    await expect(page.capture(ref(40))).rejects.toBeInstanceOf(CaptureGone);
    fake.rect = { top: 50, bottom: 100 };
    await expect(page.capture(ref(40))).rejects.toBeInstanceOf(CaptureGone);
  });

  test("a screenshot that fails while Chrome is alive is this capture's failure; with Chrome gone, the error stands", async () => {
    const { fake, page } = await open();
    fake.rects = [[50, 40]];
    await page.sync(doc("a"), GEO);
    fake.rect = { top: 50, bottom: 90 };
    const broken = new Error("Protocol error: Unable to capture screenshot");
    fake.screenshotError = broken;
    await expect(page.capture(ref(40))).rejects.toBeInstanceOf(CaptureFailed);
    fake.connected = false;
    await expect(page.capture(ref(40))).rejects.toBe(broken);
    fake.connected = true;
    fake.closed = true;
    await expect(page.capture(ref(40))).rejects.toBe(broken);
  });
});

describe("Page.sync", () => {
  const sent = (fake: FakeBrowserPage) => fake.syncCalls.at(-1)!.map((b) => (b.html === undefined ? b.key : `${b.key}+html`));

  test("sends the HTML only of blocks the page does not hold yet, counting duplicates", async () => {
    const { fake, page } = await open();
    await page.sync(doc("a", "b"), GEO);
    expect(sent(fake)).toEqual(["a+html", "b+html"]);
    await page.sync(doc("a", "new", "b", "a"), GEO);
    expect(sent(fake)).toEqual(["a", "new+html", "b", "a+html"]);
    await page.sync(doc("b"), GEO);
    expect(sent(fake)).toEqual(["b"]);
  });

  test("resends the blocks the page says it lost, and everything after a failed sync", async () => {
    const { fake, page } = await open();
    await page.sync(doc("a", "b"), GEO);
    fake.missingOnce = ["b"];
    await page.sync(doc("a", "b", "c"), GEO);
    expect(fake.syncCalls.at(-2)!.map((b) => b.html !== undefined)).toEqual([false, false, true]);
    expect(sent(fake)).toEqual(["a", "b+html", "c+html"]);

    fake.failNextSync = true;
    await expect(page.sync(doc("a", "b", "c"), GEO)).rejects.toThrow("evaluation failed");
    await page.sync(doc("a", "b", "c"), GEO);
    expect(sent(fake)).toEqual(["a+html", "b+html", "c+html"]);
  });
});
