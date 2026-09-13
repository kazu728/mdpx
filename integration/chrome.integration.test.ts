import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { buildHtml, resolveAssets } from "../src/html.ts";
import { Chrome, resolveExecutable } from "../src/chrome.ts";
import { buildLineMap, countSourceLines, sourceLineAt } from "../src/linemap.ts";
import { alignedTileHeightPx, CSS_SCALE } from "../src/viewport.ts";

const exe = await resolveExecutable();
if (!exe) {
  process.stderr.write(
    "skipping the integration tests because no Chromium was found" +
      " (install Google Chrome, or set PUPPETEER_EXECUTABLE_PATH)\n",
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
let laidOutSourceLines: ReadonlySet<number>;

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
    laidOutSourceLines = built.laidOutSourceLines;

    chrome = new Chrome(exe);
    await chrome.launch();
    const documentHeightCssPx = await chrome.load(htmlPath, CSS_WIDTH, CSS_SCALE);
    expect(documentHeightCssPx).toBeGreaterThan(0);
  }, 60000);

  afterAll(async () => {
    await chrome?.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("KaTeX is rendered server-side and .katex exists", async () => {
    expect(await chrome.page!.evaluate(() => document.querySelectorAll(".katex").length)).toBeGreaterThan(0);
  });

  test("Mermaid becomes SVG on the client", async () => {
    expect(await chrome.page!.evaluate(() => document.querySelectorAll(".mermaid svg").length)).toBe(1);
  });

  test("the image, code, and table are present in the DOM", async () => {
    const dom = await chrome.page!.evaluate(() => ({
      imgs: document.images.length,
      shiki: document.querySelectorAll("pre.shiki").length,
      table: document.querySelectorAll("table").length,
    }));
    expect(dom.imgs).toBeGreaterThanOrEqual(1);
    expect(dom.shiki).toBeGreaterThan(0);
    expect(dom.table).toBe(1);
  });

  test("a meta refresh in the markdown body is stripped and never navigates", async () => {
    const evil = join(dir, "evil.html");
    await writeFile(
      evil,
      (
        await buildHtml({
          markdown: '<meta http-equiv="refresh" content="0;url=https://example.com/land">\n\n# body\n',
          mdDir: dir,
          assets: resolveAssets("light"),
          theme: "light",
        })
      ).html,
    );
    await chrome.load(evil, CSS_WIDTH, CSS_SCALE);
    expect(await chrome.page!.evaluate(() => location.protocol)).toBe("file:");
    expect(await chrome.page!.evaluate(() => document.querySelectorAll("meta[http-equiv]").length)).toBe(1);
    await chrome.load(htmlPath, CSS_WIDTH, CSS_SCALE);
  }, 30000);

  describe("line anchors", () => {
    test("collectAnchors returns {line, CSS px} in document order, increasing", async () => {
      const anchors = await chrome.collectAnchors();
      expect(anchors.length).toBeGreaterThan(5);
      for (const anchor of anchors) {
        expect(Number.isInteger(anchor.sourceLine)).toBe(true);
        expect(anchor.sourceLine).toBeGreaterThanOrEqual(1);
      }
      const lines = anchors.map((anchor) => anchor.sourceLine);
      expect(lines).toEqual([...lines].sort((x, y) => x - y));
      const tops = anchors.map((anchor) => anchor.topCssPx);
      expect(tops).toEqual([...tops].sort((x, y) => x - y));
      expect(anchors[0]!.sourceLine).toBe(1);
    });

    test("a scroll px resolves to the fixture's heading line (including the physical px → CSS px conversion)", async () => {
      const md = await readFile(FIXTURE, "utf8");
      const anchors = await chrome.collectAnchors();
      const documentHeightCssPx = await chrome.page!.evaluate(() =>
        Math.max(document.body.scrollHeight, document.documentElement.scrollHeight),
      );
      const map = buildLineMap(
        anchors,
        countSourceLines(md),
        documentHeightCssPx,
        laidOutSourceLines,
      );

      const topCssPx = anchors.find((anchor) => anchor.sourceLine === 14)?.topCssPx;
      expect(topCssPx).toBeDefined();
      const scrollPx = topCssPx! * CSS_SCALE;
      expect(sourceLineAt(map, scrollPx / CSS_SCALE, false)).toBe(14);
      expect(sourceLineAt(map, 0, false)).toBe(1);
      expect(sourceLineAt(map, 0, true)).toBe(countSourceLines(md));
    });

    test("no scroll position ever lands on a blank line", async () => {
      const md = await readFile(FIXTURE, "utf8");
      const anchors = await chrome.collectAnchors();
      const documentHeightCssPx = await chrome.page!.evaluate(() =>
        Math.max(document.body.scrollHeight, document.documentElement.scrollHeight),
      );
      const map = buildLineMap(
        anchors,
        countSourceLines(md),
        documentHeightCssPx,
        laidOutSourceLines,
      );
      const blank = new Set(
        md.split("\n").flatMap((text, i) => (text.trim() === "" ? [i + 1] : [])),
      );
      expect(blank.size).toBeGreaterThan(5);
      const landed = new Set<number>();
      for (
        let viewportTopCssPx = 0;
        viewportTopCssPx <= documentHeightCssPx;
        viewportTopCssPx += CELL_HPX / CSS_SCALE
      ) {
        landed.add(sourceLineAt(map, viewportTopCssPx, false));
      }
      expect([...landed].filter((line) => blank.has(line))).toEqual([]);
    });
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

  test("shoot returns a PNG of the requested size (CSS px * dsf)", async () => {
    const b64 = await chrome.shoot({
      xCssPx: 0,
      yCssPx: 0,
      widthCssPx: CSS_WIDTH,
      heightCssPx: 100,
    });
    expect(pngSize(Buffer.from(b64, "base64")).height).toBe(100 * CSS_SCALE);
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
