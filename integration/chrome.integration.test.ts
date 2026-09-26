import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { buildHtml, resolveAssets } from "../src/html.ts";
import { Chrome, resolveExecutable } from "../src/chrome.ts";
import { alignedTileHeightPx, CSS_SCALE } from "../src/viewport.ts";

const exe = await resolveExecutable();
if (!exe) {
  process.stderr.write(
    "skipping the integration tests because no Chromium was found" +
      " (install Google Chrome or Chromium, or set PUPPETEER_EXECUTABLE_PATH)\n",
  );
}

const FIXTURE = resolve(import.meta.dir, "fixtures/sample.md");
const CELL_HPX = 31;
const CONTENT_ROWS = 64;
const CSS_WIDTH = 490;
const PNG_IHDR_WIDTH_OFFSET = 16;
const PNG_IHDR_HEIGHT_OFFSET = 20;

let dir: string;
let htmlPath: string;
let chrome: Chrome;

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
    const built = await buildHtml({
      markdown: md,
      mdDir: dirname(FIXTURE),
      assets: resolveAssets("light"),
      theme: "light",
    });
    await writeFile(htmlPath, built.html);

    chrome = new Chrome(exe);
    await chrome.launch();
    const documentHeightCssPx = await chrome.load(htmlPath, CSS_WIDTH, CSS_SCALE);
    expect(documentHeightCssPx).toBeGreaterThan(0);
  }, 60000);

  afterAll(async () => {
    await chrome?.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("Mermaid becomes SVG on the client", async () => {
    expect(await chrome.page!.evaluate(() => document.querySelectorAll(".mermaid svg").length)).toBe(1);
  });

  test("the tile screenshot's PNG dimensions are cell-aligned", async () => {
    const tileH = alignedTileHeightPx(CELL_HPX, CONTENT_ROWS);
    const b64 = await chrome.shoot({
      xCssPx: 0,
      yCssPx: 0,
      widthCssPx: CSS_WIDTH,
      heightCssPx: tileH / CSS_SCALE,
    });
    const { width, height } = pngSize(Buffer.from(b64, "base64"));
    expect(height).toBe(tileH);
    expect(height % CELL_HPX).toBe(0);
    expect(width).toBe(CSS_WIDTH * CSS_SCALE);
  });

  test("renderScale=1 keeps the same CSS layout and only halves the image", async () => {
    const full = await chrome.load(htmlPath, CSS_WIDTH, CSS_SCALE);
    const fullPng = pngSize(
      Buffer.from(
        await chrome.shoot({
          xCssPx: 0,
          yCssPx: 0,
          widthCssPx: CSS_WIDTH,
          heightCssPx: 100,
        }),
        "base64",
      ),
    );

    const reduced = await chrome.load(htmlPath, CSS_WIDTH, 1);
    const reducedPng = pngSize(
      Buffer.from(
        await chrome.shoot({
          xCssPx: 0,
          yCssPx: 0,
          widthCssPx: CSS_WIDTH,
          heightCssPx: 100,
        }),
        "base64",
      ),
    );

    expect(reduced).toBe(full);
    expect(reducedPng.width * 2).toBe(fullPng.width);
    expect(reducedPng.height * 2).toBe(fullPng.height);

    await chrome.load(htmlPath, CSS_WIDTH, CSS_SCALE);
  }, 30000);
});
