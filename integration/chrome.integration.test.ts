// Slow, real Chrome (§7). Renders the fixture and verifies it mechanically through the DOM.
//   Run with bun run test:integration (kept apart from the units in bun test src/).
// What is under test is the production code itself: launching, loading, and capturing all go through
// the Chrome class (driving puppeteer directly here would duplicate the launch flags and the
// wait-for-settle logic, and the production path would go green without ever being tested).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { resolveAssets } from "../src/assets.ts";
import { buildHtml } from "../src/html.ts";
import { Chrome, resolveExecutable } from "../src/chrome.ts";
import { buildLineMap, countLines, lineAt } from "../src/linemap.ts";
import { CSS_SCALE, tileHeightPx } from "../src/viewport.ts";

const exe = resolveExecutable();
if (!exe) {
  // A skip exits 0 and goes unnoticed, so always state the reason (§4.3's resolution order is shared with production)
  process.stderr.write(
    "skipping the integration tests because no Chromium was found" +
      " (install Google Chrome, or set PUPPETEER_EXECUTABLE_PATH)\n",
  );
}

const FIXTURE = resolve(import.meta.dir, "fixtures/sample.md");
// Inputs for the tile dimension assertions. tileHeightPx guarantees cell alignment, so nothing depends on the measured values themselves.
const CELL_HPX = 31;
const CONTENT_ROWS = 64; // a tile is one screenful (§4.3), so the geometry is needed
const CSS_WIDTH = 490;

let dir: string;
let htmlPath: string;
let chrome: Chrome;
let laidOut: readonly boolean[];

function pngSize(data: Uint8Array): { width: number; height: number } {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return { width: dv.getUint32(16), height: dv.getUint32(20) }; // IHDR
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
    laidOut = built.laidOut;

    chrome = new Chrome();
    await chrome.launch();
    const docHpx = await chrome.load(htmlPath, CSS_WIDTH, CSS_SCALE);
    expect(docHpx).toBeGreaterThan(0);
  }, 60000);

  afterAll(async () => {
    await chrome?.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("KaTeX is rendered server-side and .katex exists", async () => {
    expect(await chrome.evaluate(() => document.querySelectorAll(".katex").length)).toBeGreaterThan(0);
  });

  test("Mermaid becomes SVG on the client", async () => {
    expect(await chrome.evaluate(() => document.querySelectorAll(".mermaid svg").length)).toBe(1);
  });

  test("the image, code, and table are present in the DOM", async () => {
    const dom = await chrome.evaluate(() => ({
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
    expect(await chrome.evaluate(() => location.protocol)).toBe("file:");
    expect(await chrome.evaluate(() => document.querySelectorAll("meta[http-equiv]").length)).toBe(1);
    await chrome.load(htmlPath, CSS_WIDTH, CSS_SCALE);
  }, 30000);

  // §4.9's seam. The DOM works in CSS px and the scheduler in physical px, and getting the conversion
  // wrong raises no exception — it degrades quietly into "the cursor jumps to a line twice as far
  // off". This is the only net.
  describe("line anchors (§4.9)", () => {
    test("collectAnchors returns {line, CSS px} in document order, increasing", async () => {
      const anchors = await chrome.collectAnchors();
      expect(anchors.length).toBeGreaterThan(5);
      for (const a of anchors) {
        expect(Number.isInteger(a.line)).toBe(true);
        expect(a.line).toBeGreaterThanOrEqual(1);
      }
      const lines = anchors.map((a) => a.line);
      expect(lines).toEqual([...lines].sort((x, y) => x - y));
      const tops = anchors.map((a) => a.top);
      expect(tops).toEqual([...tops].sort((x, y) => x - y));
      expect(anchors[0]!.line).toBe(1);
    });

    test("a scroll px resolves to the fixture's heading line (including the physical px → CSS px conversion)", async () => {
      const md = await readFile(FIXTURE, "utf8");
      const anchors = await chrome.collectAnchors();
      const docHpx =
        (await chrome.evaluate(() =>
          Math.max(document.body.scrollHeight, document.documentElement.scrollHeight),
        )) * CSS_SCALE;
      const map = buildLineMap(anchors, countLines(md), docHpx / CSS_SCALE, laidOut);

      // "## Diagram (Mermaid)" is line 14 of the fixture. Simulate scrolling to the top of that element
      const top = anchors.find((a) => a.line === 14)?.top;
      expect(top).toBeDefined();
      // What main.ts holds is a scrollPx in physical px; divide by CSS_SCALE before handing it to the LineMap
      const scrollPx = top! * CSS_SCALE;
      expect(lineAt(map, scrollPx / CSS_SCALE, false)).toBe(14);
      expect(lineAt(map, 0, false)).toBe(1);
      expect(lineAt(map, 0, true)).toBe(countLines(md));
    });

    // A blank line takes a line in the source but has no place in the rendering. The interpolation
    // apportions px to it and lands there, putting the nvim cursor on the blank line after the
    // paragraph being read rather than on the paragraph. laidOut closes that off
    test("no scroll position ever lands on a blank line", async () => {
      const md = await readFile(FIXTURE, "utf8");
      const anchors = await chrome.collectAnchors();
      const docCssH = await chrome.evaluate(() =>
        Math.max(document.body.scrollHeight, document.documentElement.scrollHeight),
      );
      const map = buildLineMap(anchors, countLines(md), docCssH, laidOut);
      // Every blank line in the fixture is outside a fence, so a plain blank-line check works as an
      // independent criterion
      const blank = new Set(
        md.split("\n").flatMap((text, i) => (text.trim() === "" ? [i + 1] : [])),
      );
      expect(blank.size).toBeGreaterThan(5);
      const landed = new Set<number>();
      for (let cssY = 0; cssY <= docCssH; cssY += CELL_HPX / CSS_SCALE) {
        landed.add(lineAt(map, cssY, false));
      }
      expect([...landed].filter((line) => blank.has(line))).toEqual([]);
    });
  });

  test("the tile screenshot's PNG dimensions are cell-aligned", async () => {
    const tileH = tileHeightPx(CELL_HPX, CONTENT_ROWS); // physical px
    const b64 = await chrome.shoot({ x: 0, y: 0, width: CSS_WIDTH, height: tileH / CSS_SCALE });
    const { width, height } = pngSize(Buffer.from(b64, "base64"));
    expect(height).toBe(tileH);
    expect(height % CELL_HPX).toBe(0); // placement rows are integers
    expect(width).toBe(CSS_WIDTH * CSS_SCALE);
  });

  test("shoot returns a PNG of the requested size (CSS px * dsf)", async () => {
    const b64 = await chrome.shoot({ x: 0, y: 0, width: CSS_WIDTH, height: 100 });
    expect(pngSize(Buffer.from(b64, "base64")).height).toBe(100 * CSS_SCALE);
  });

  // The foundation of §4.8's downscale fallback. Confirm in real Chrome that lowering the
  // deviceScaleFactor leaves the CSS layout untouched and only halves the image in both directions
  // (i.e. the relayed volume drops to a quarter while the reflow is preserved).
  test("renderScale=1 keeps the same CSS layout and only halves the image", async () => {
    const full = await chrome.load(htmlPath, CSS_WIDTH, CSS_SCALE);
    const fullPng = pngSize(Buffer.from(await chrome.shoot({ x: 0, y: 0, width: CSS_WIDTH, height: 100 }), "base64"));

    const reduced = await chrome.load(htmlPath, CSS_WIDTH, 1);
    const reducedPng = pngSize(Buffer.from(await chrome.shoot({ x: 0, y: 0, width: CSS_WIDTH, height: 100 }), "base64"));

    expect(reduced).toBe(full);
    expect(reducedPng.width * 2).toBe(fullPng.width);
    expect(reducedPng.height * 2).toBe(fullPng.height);

    await chrome.load(htmlPath, CSS_WIDTH, CSS_SCALE); // restore for the tests that follow
  }, 30000);
});
