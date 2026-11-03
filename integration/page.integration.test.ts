import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Page as BrowserPage } from "puppeteer-core";
import { Chrome, resolveExecutable } from "../src/chrome.ts";
import { CELL_CSS_PX, resolveGeometry, type Geometry } from "../src/geometry.ts";
import { buildLayout, type Layout } from "../src/layout.ts";
import { renderDocument, type Doc } from "../src/markdown.ts";
import { CaptureGone, Page, resolveAssets, type Capture } from "../src/page.ts";

const exe = await resolveExecutable();
if (!exe) {
  process.stderr.write(
    "skipping the integration tests because no Chromium was found" +
      " (install Google Chrome or Chromium, or set PUPPETEER_EXECUTABLE_PATH)\n",
  );
}

const FIXTURE = resolve(import.meta.dir, "fixtures/sample.md");
const LIMITS = { frameBytes: null, storageBytes: 320_000_000 };
const PNG_IHDR_WIDTH_OFFSET = 16;
const PNG_IHDR_HEIGHT_OFFSET = 20;

let dir: string;
let chrome: Chrome;
let browserPage: BrowserPage;
let page: Page;
let markdown: string;

function pngSize(base64: string): { width: number; height: number } {
  const data = Buffer.from(base64, "base64");
  return { width: data.readUInt32BE(PNG_IHDR_WIDTH_OFFSET), height: data.readUInt32BE(PNG_IHDR_HEIGHT_OFFSET) };
}

const render = (md: string): Promise<Doc> => renderDocument(md, { theme: "light", mdDir: dirname(FIXTURE) });

async function sync(md: string, g: Geometry): Promise<Layout> {
  return buildLayout(await page.sync(await render(md), g), g);
}

/**
 * Share of differing pixels between the content rows of two captures of one slice, taken at
 * different row phases: the content is lined up by where each capture says it starts, allowing
 * Chrome's pixel snapping to have moved it by one row either way.
 */
function contentDifference(a: Capture, b: Capture, rows: number): Promise<number> {
  return browserPage.evaluate(
    async (x: string, ya: number, y: string, yb: number, n: number) => {
      const load = async (s: string) => {
        const img = new Image();
        img.src = "data:image/png;base64," + s;
        await img.decode();
        const c = document.createElement("canvas");
        c.width = img.width;
        c.height = img.height;
        const ctx = c.getContext("2d")!;
        ctx.drawImage(img, 0, 0);
        return { w: img.width, h: img.height, d: ctx.getImageData(0, 0, img.width, img.height).data };
      };
      const [p, q] = [await load(x), await load(y)];
      let best = Infinity;
      for (const shift of [-1, 0, 1]) {
        let diff = 0;
        for (let r = 0; r < n; r++) {
          const ra = ya + r;
          const rb = yb + r + shift;
          if (ra < 0 || rb < 0 || ra >= p.h || rb >= q.h) continue;
          for (let c = 0; c < Math.min(p.w, q.w); c++) {
            const i = (ra * p.w + c) * 4;
            const j = (rb * q.w + c) * 4;
            if (p.d[i] !== q.d[j] || p.d[i + 1] !== q.d[j + 1] || p.d[i + 2] !== q.d[j + 2]) diff++;
          }
        }
        best = Math.min(best, diff / (n * Math.min(p.w, q.w)));
      }
      return best;
    },
    a.pngBase64,
    Math.round(a.contentTopImgPx),
    b.pngBase64,
    Math.round(b.contentTopImgPx),
    rows,
  );
}

function inkedRows(base64: string): Promise<number[]> {
  return browserPage.evaluate(async (s: string) => {
    const img = new Image();
    img.src = "data:image/png;base64," + s;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext("2d")!;
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, img.width, img.height).data;
    const rows: number[] = [];
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        const i = (y * img.width + x) * 4;
        if (d[i]! < 250 || d[i + 1]! < 250 || d[i + 2]! < 250) {
          rows.push(y);
          break;
        }
      }
    }
    return rows;
  }, base64);
}

describe.skipIf(!exe)("page", () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "mdpx-it-"));
    markdown = await readFile(FIXTURE, "utf8");
    chrome = new Chrome(exe!);
    browserPage = await chrome.launch();
    page = await Page.open(browserPage, { mdDir: dirname(FIXTURE), assets: resolveAssets(), dir, onReflow: () => {} });
  }, 60000);

  afterAll(async () => {
    await chrome?.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("wrapping each block leaves GitHub's layout exactly as it was", async () => {
    const g = resolveGeometry({ cols: 120, rows: 40 }, { cellHpx: 28, cellWpx: 14 }, LIMITS);
    await sync(markdown, g);
    const drift = await browserPage.evaluate(() => {
      const wrapped = document.querySelector("article.markdown-body")!;
      const plain = wrapped.cloneNode(true) as HTMLElement;
      for (const w of Array.from(plain.querySelectorAll(":scope > .mdpx-block"))) w.replaceWith(...Array.from(w.childNodes));
      Object.assign(plain.style, { position: "absolute", top: "0", left: "0", right: "0" });
      document.body.appendChild(plain);
      const firsts = Array.from(wrapped.children, (w) => w.firstElementChild).filter((e): e is Element => !!e);
      const top = (e: Element, root: Element) => e.getBoundingClientRect().top - root.getBoundingClientRect().top;
      const drifts = firsts.map((e, i) => Math.abs(top(e, wrapped) - top(plain.children[i]!, plain)));
      const heights = Math.abs(wrapped.getBoundingClientRect().height - plain.getBoundingClientRect().height);
      plain.remove();
      return Math.max(heights, ...drifts);
    });
    expect(drift).toBe(0);
  }, 30000);

  test("Mermaid becomes SVG, and every slice is a row of blank page, the block, and another row of blank page", async () => {
    const g = resolveGeometry({ cols: 120, rows: 40 }, { cellHpx: 28, cellWpx: 14 }, LIMITS);
    const layout = await sync(markdown, g);
    expect(await browserPage.evaluate(() => document.querySelectorAll(".mermaid svg").length)).toBe(1);
    expect(layout.units.length).toBeGreaterThan(10);
    for (const unit of layout.units) {
      for (const slice of unit.slices) {
        const shot = await page.capture(slice.capture);
        const { width, height } = pngSize(shot.pngBase64);
        expect(height).toBe(shot.heightImgPx);
        expect(width).toBeGreaterThanOrEqual(g.imgWidthPx);
        // Only page within one row of the content, except that a neighbor exactly one row away
        // may show its edge (smoothed, when scaled) in the outermost px, as on the real page.
        const row = CELL_CSS_PX * g.deviceScaleFactor;
        const top = shot.contentTopImgPx;
        const bottom = top + slice.capture.lengthCss * g.deviceScaleFactor;
        const inMargins = (await inkedRows(shot.pngBase64)).filter(
          (y) => (y > top - row + 2 && y < top - 2) || (y > bottom + 2 && y < bottom + row - 2),
        );
        expect(inMargins).toEqual([]);
      }
    }
  }, 60000);

  for (const cellHpx of [27, 28]) {
    test(`${cellHpx}px cells: a block moved by an edit above still matches its old capture`, async () => {
      const g = resolveGeometry({ cols: 120, rows: 40 }, { cellHpx, cellWpx: 14 }, LIMITS);
      const before = await sync(markdown, g);
      const shots = new Map<string, Capture>();
      for (const [key, slice] of before.slices) shots.set(key, await page.capture(slice.capture));
      const after = await sync(`Inserted line one,\nand a second line.\n\n${markdown}`, g);
      let compared = 0;
      for (const [key, slice] of after.slices) {
        const old = shots.get(key);
        if (!old) continue;
        const fresh = await page.capture(slice.capture);
        const rows = Math.floor(slice.capture.lengthCss * g.deviceScaleFactor);
        // Antialiasing may differ in a few pixels; anything visible would be far more.
        expect(await contentDifference(old, fresh, rows)).toBeLessThan(0.002);
        compared++;
      }
      expect(compared).toBe(before.slices.size);
    }, 60000);
  }

  test("syncing the same document keeps every node, and a reorder keeps the rendered diagram", async () => {
    const g = resolveGeometry({ cols: 120, rows: 40 }, { cellHpx: 28, cellWpx: 14 }, LIMITS);
    const md = "intro\n\n```mermaid\ngraph TD; A-->B\n```\n\noutro\n";
    const first = await page.sync(await render(md), g);
    await browserPage.evaluate(() => {
      for (const w of Array.from(document.querySelectorAll(".mdpx-block"))) (w as unknown as { mark: boolean }).mark = true;
      (document.querySelector(".mermaid svg") as unknown as { mark: boolean }).mark = true;
    });
    expect(await page.sync(await render(md), g)).toEqual(first);
    expect(
      await browserPage.evaluate(() =>
        Array.from(document.querySelectorAll(".mdpx-block")).every((w) => (w as unknown as { mark?: boolean }).mark),
      ),
    ).toBe(true);
    await page.sync(await render("```mermaid\ngraph TD; A-->B\n```\n\nintro\n\noutro\n"), g);
    expect(await browserPage.evaluate(() => (document.querySelector(".mermaid svg") as unknown as { mark?: boolean })?.mark)).toBe(true);
  }, 30000);

  test("a floated README logo is captured whole, with the blocks it overlaps", async () => {
    const g = resolveGeometry({ cols: 120, rows: 40 }, { cellHpx: 28, cellWpx: 14 }, LIMITS);
    const logo = (h: number) => `<img align="right" src="red.png" width="120" height="${h}">\n\n# Project\n\nOne line about it.\n\nMore text.\n`;
    const layout = await sync(logo(240), g);
    const img = await browserPage.evaluate(() => {
      const r = document.querySelector("img")!.getBoundingClientRect();
      return { top: r.top + scrollY, bottom: r.bottom + scrollY };
    });
    const unit = layout.units.find((u) => u.members.some((m) => m.key === layout.blockKeys[0]))!;
    expect(unit.members.length).toBeGreaterThan(1);
    expect(unit.rowStart * CELL_CSS_PX).toBeLessThanOrEqual(img.top);
    expect(unit.rowEnd * CELL_CSS_PX).toBeGreaterThanOrEqual(img.bottom);
    const shot = await page.capture(unit.slices[0]!.capture);
    const red = await browserPage.evaluate(async (s: string) => {
      const im = new Image();
      im.src = "data:image/png;base64," + s;
      await im.decode();
      const c = document.createElement("canvas");
      c.width = im.width;
      c.height = im.height;
      const ctx = c.getContext("2d")!;
      ctx.drawImage(im, 0, 0);
      const d = ctx.getImageData(0, 0, im.width, im.height).data;
      const rows: number[] = [];
      for (let y = 0; y < im.height; y++) {
        for (let x = 0; x < im.width; x++) {
          const i = (y * im.width + x) * 4;
          if (d[i]! > 200 && d[i + 1]! < 80 && d[i + 2]! < 80) {
            rows.push(y);
            break;
          }
        }
      }
      return rows;
    }, shot.pngBase64);
    // Every image px row of the logo is in the capture.
    expect(red.length).toBeGreaterThanOrEqual(Math.floor((img.bottom - img.top) * g.deviceScaleFactor) - 1);
    // Changing only the logo changes the unit's image, so no stale pixels survive.
    const resized = await sync(logo(200), g);
    expect([...resized.slices.keys()]).not.toContain(unit.slices[0]!.imageKey);
  }, 30000);

  test("a block that vanished from the page is sent again on the next sync", async () => {
    const g = resolveGeometry({ cols: 120, rows: 40 }, { cellHpx: 28, cellWpx: 14 }, LIMITS);
    const md = "one\n\ntwo\n\nthree\n";
    const first = await page.sync(await render(md), g);
    await browserPage.evaluate(() => document.querySelectorAll(".mdpx-block")[1]!.remove());
    const again = await page.sync(await render(md), g);
    expect(again).toEqual(first);
    expect(await browserPage.evaluate(() => Array.from(document.querySelectorAll(".mdpx-block"), (w) => w.textContent!.trim()))).toEqual([
      "one",
      "two",
      "three",
    ]);
  }, 30000);

  test("a capture from a layout the page has moved on from is refused", async () => {
    const g = resolveGeometry({ cols: 120, rows: 40 }, { cellHpx: 28, cellWpx: 14 }, LIMITS);
    const layout = await sync("one\n\ntwo\n", g);
    const slice = [...layout.slices.values()][0]!;
    await page.sync(await render("one\nlonger now\n\ntwo\n"), g);
    await expect(page.capture(slice.capture)).rejects.toBeInstanceOf(CaptureGone);
  }, 30000);
});
