import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { buildHtml, resolveAssets } from "../src/html.ts";
import { Chrome, resolveExecutable } from "../src/chrome.ts";
import {
  alignedTileHeightPx,
  contentRows,
  detectGraphicsLimits,
  resolveGeometry,
  toCssPx,
  toImagePx,
} from "../src/geometry.ts";

const exe = await resolveExecutable();
if (!exe) {
  process.stderr.write(
    "skipping the integration tests because no Chromium was found" +
      " (install Google Chrome or Chromium, or set PUPPETEER_EXECUTABLE_PATH)\n",
  );
}

const FIXTURE = resolve(import.meta.dir, "fixtures/sample.md");
const SCREEN = { cols: 300, rows: 65 };
const CELL_WPX = 14;
const PNG_IHDR_WIDTH_OFFSET = 16;
const PNG_IHDR_HEIGHT_OFFSET = 20;

let dir: string;
let htmlPath: string;
let layoutPath: string;
let chrome: Chrome;

function geometryFor(cellHpx: number, env: NodeJS.ProcessEnv = {}) {
  return resolveGeometry(SCREEN, { cellHpx, cellWpx: CELL_WPX }, detectGraphicsLimits(env));
}

function pngSize(data: Uint8Array): { width: number; height: number } {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    width: dv.getUint32(PNG_IHDR_WIDTH_OFFSET),
    height: dv.getUint32(PNG_IHDR_HEIGHT_OFFSET),
  };
}

describe.skipIf(!exe)("chrome + html pipeline", () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "mdpx-it-"));
    htmlPath = join(dir, "view.html");
    const md = await readFile(FIXTURE, "utf8");
    const html = await buildHtml({
      markdown: md,
      mdDir: dirname(FIXTURE),
      assets: resolveAssets(),
      theme: "light",
    });
    await writeFile(htmlPath, html);
    // Font loading and Mermaid can change the sample document's height between loads.
    layoutPath = join(dir, "layout.html");
    await writeFile(
      layoutPath,
      await buildHtml({
        markdown: `<div style="height: 1200px"></div>`,
        mdDir: dirname(FIXTURE),
        assets: resolveAssets(),
        theme: "light",
      }),
    );

    chrome = new Chrome(exe!);
    await chrome.launch();
  }, 60000);

  afterAll(async () => {
    await chrome?.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("Mermaid becomes SVG on the client", async () => {
    const g = geometryFor(31);
    expect(await chrome.load(htmlPath, g.viewportWidthCssPx, g.deviceScaleFactor)).toBeGreaterThan(0);
    expect(await chrome.page!.evaluate(() => document.querySelectorAll(".mermaid svg").length)).toBe(1);
  }, 30000);

  for (const cellHpx of [31, 33]) {
    test(`${cellHpx}px cells: both render scales keep the CSS layout and cover the tile crop`, async () => {
      const full = geometryFor(cellHpx);
      const reduced = geometryFor(cellHpx, { HERDR_ENV: "1" });
      expect(reduced.renderScale).toBeLessThan(full.renderScale);
      const tileH = alignedTileHeightPx(cellHpx, contentRows(SCREEN.rows));
      const documentHeightsCssPx: number[] = [];
      for (const g of [full, reduced]) {
        documentHeightsCssPx.push(await chrome.load(layoutPath, g.viewportWidthCssPx, g.deviceScaleFactor));
        const png = pngSize(Buffer.from(await chrome.shoot(0, toCssPx(tileH, cellHpx)), "base64"));
        expect(png.height).toBe(toImagePx(tileH, g.renderScale));
        expect(png.width).toBeGreaterThanOrEqual(g.imgWidthPx);
      }
      expect(documentHeightsCssPx[1]).toBe(documentHeightsCssPx[0]);
    }, 30000);
  }
});
