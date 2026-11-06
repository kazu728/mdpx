import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Page as BrowserPage } from "puppeteer-core";
import { ARTICLE_MAX_WIDTH_CSS, captureClipCss, type Geometry } from "./geometry.ts";
import type { CaptureRef, CapturedImage, SyncedLayout } from "./layout.ts";
import { documentBaseUrl, type Doc } from "./markdown.ts";
import { PAGE_BACKGROUND, type Theme } from "./theme.ts";

const require = createRequire(import.meta.url);


export class CaptureGone extends Error {}

export class CaptureFailed extends Error {}

export interface Capture extends CapturedImage {
  readonly pngBase64: string;
}

export interface Assets {
  githubMarkdownCss: Record<Theme, string>;
  katexCss: string;
  mermaidJs: string;
}

export function resolveAssets(): Assets {
  return {
    githubMarkdownCss: {
      light: require.resolve("github-markdown-css/github-markdown-light.css"),
      dark: require.resolve("github-markdown-css/github-markdown-dark.css"),
    },
    katexCss: require.resolve("katex/dist/katex.min.css"),
    mermaidJs: require.resolve("mermaid/dist/mermaid.min.js"),
  };
}

const NAV_TIMEOUT_MS = 15000;
const VIEWPORT_HEIGHT_CSS_PX = 900;
const STABLE_FONTS_MS = 500;
const STABLE_IMG_DECODE_MS = 1000;
const STABLE_MERMAID_MS = 3000;
const REFLOW_DEBOUNCE_MS = 50;

interface SyncBlock {
  key: string;
  html?: string;
}

type SyncResult =
  | { rects: [top: number, height: number][]; docHeight: number }
  | { missing: string[] };

declare global {
  interface Window {
    __mdpx: {
      sync(blocks: SyncBlock[], theme: Theme): Promise<SyncResult>;
      rect(first: [string, number], last: [string, number]): { top: number; bottom: number } | null;
    };
  }
}

function contentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    "style-src 'unsafe-inline' file:",
    "img-src file: data: https: http:",
    "font-src file:",
    "connect-src 'none'",
    "base-uri file:",
  ].join("; ");
}

/**
 * Runs in the page. Wrappers are plain blocks, so the margins of the elements inside them
 * collapse exactly as they would without the wrapper; only GitHub's first/last-child rules
 * need restating one level down.
 */
const RUNTIME = String.raw`
(function (config) {
  const article = document.querySelector("article.markdown-body");
  const heights = new WeakMap();
  let syncing = false;
  let reflowTimer = 0;
  // What a block paints, not just its box: a floated image overflows a wrapper that may be
  // zero pixels tall, and it must be captured with the blocks it overlaps. Walking a block's
  // content is slow, so how far it paints beyond its box is kept until the block or the
  // page width changes; moving the block moves its overflow with it.
  const overflow = new WeakMap();
  function extent(w) {
    const box = w.getBoundingClientRect();
    let o = overflow.get(w);
    if (!o || o.width !== innerWidth) {
      o = { width: innerWidth, height: box.height, above: 0, below: 0 };
      if (w.scrollHeight > box.height + 1) {
        const range = document.createRange();
        range.selectNodeContents(w);
        const ink = range.getBoundingClientRect();
        if (ink.width > 0 || ink.height > 0) {
          o.above = Math.max(0, box.top - ink.top);
          o.below = Math.max(0, ink.bottom - box.bottom);
        }
      }
      overflow.set(w, o);
    }
    return { top: box.top - o.above + scrollY, bottom: box.bottom + o.below + scrollY };
  }
  // A late image or diagram can change what a block paints without resizing its wrapper.
  function scheduleReflowCheck(changed) {
    for (const w of changed) overflow.delete(w);
    if (syncing) return;
    clearTimeout(reflowTimer);
    reflowTimer = setTimeout(() => {
      for (const w of wrappers()) {
        const e = extent(w);
        if (Math.abs(e.bottom - e.top - (heights.get(w) ?? 0)) > 0.5) {
          if (window.__mdpxReflow) window.__mdpxReflow();
          return;
        }
      }
    }, config.reflowMs);
  }
  // Observing a block reports its size once; only a size that differs from the one measured counts.
  const observer = new ResizeObserver((entries) => {
    const changed = entries
      .map((e) => e.target)
      .filter((w) => Math.abs(w.getBoundingClientRect().height - (overflow.get(w)?.height ?? -1)) > 0.5);
    if (changed.length) scheduleReflowCheck(changed);
  });
  article.addEventListener(
    "load",
    (event) => {
      const w = event.target.closest && event.target.closest(".mdpx-block");
      scheduleReflowCheck(w ? [w] : []);
    },
    true,
  );
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let mermaidLoad = null;
  let mermaidTheme = null;
  function loadMermaid() {
    return (mermaidLoad ??= new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = config.mermaidJs;
      s.nonce = config.nonce;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error("mermaid failed to load"));
      document.head.appendChild(s);
    }));
  }
  async function renderMermaid(nodes, theme) {
    await loadMermaid();
    if (mermaidTheme !== theme) {
      mermaid.initialize({ startOnLoad: false, theme: theme === "dark" ? "dark" : "default" });
      mermaidTheme = theme;
    }
    for (const node of nodes) {
      try { await mermaid.run({ nodes: [node] }); } catch (e) {}
    }
  }
  function applyTheme(theme) {
    document.getElementById("mdpx-light").disabled = theme !== "light";
    document.getElementById("mdpx-dark").disabled = theme !== "dark";
    document.documentElement.style.background = config.background[theme];
  }
  async function settle(fresh, theme) {
    await Promise.race([document.fonts.ready, sleep(config.fontsMs)]);
    const images = fresh.flatMap((w) => Array.from(w.querySelectorAll("img")));
    await Promise.race([Promise.all(images.map((i) => i.decode().catch(() => {}))), sleep(config.imagesMs)]);
    const diagrams = fresh.flatMap((w) => Array.from(w.querySelectorAll("pre.mermaid")));
    if (diagrams.length) await Promise.race([renderMermaid(diagrams, theme).catch(() => {}), sleep(config.mermaidMs)]);
  }
  const wrappers = () => Array.from(article.children);
  window.__mdpx = {
    async sync(blocks, theme) {
      const pool = new Map();
      for (const w of wrappers()) {
        const list = pool.get(w.dataset.key);
        if (list) list.push(w); else pool.set(w.dataset.key, [w]);
      }
      const left = new Map(Array.from(pool, ([key, list]) => [key, list.length]));
      const missing = new Set();
      for (const b of blocks) {
        const n = left.get(b.key) ?? 0;
        if (n > 0) left.set(b.key, n - 1);
        else if (b.html === undefined) missing.add(b.key);
      }
      if (missing.size) return { missing: Array.from(missing) };
      syncing = true;
      try {
        applyTheme(theme);
        const ordered = [];
        const fresh = [];
        for (const b of blocks) {
          let w = pool.get(b.key)?.shift();
          if (!w) {
            w = document.createElement("div");
            w.className = "mdpx-block";
            w.dataset.key = b.key;
            // innerHTML never runs scripts, and the CSP still applies to everything else.
            w.innerHTML = b.html;
            fresh.push(w);
          }
          ordered.push(w);
        }
        for (const list of pool.values()) for (const w of list) { observer.unobserve(w); w.remove(); }
        // insertBefore moves a node without re-creating it, so rendered diagrams survive a reorder.
        let cursor = article.firstElementChild;
        for (const w of ordered) {
          if (w === cursor) cursor = cursor.nextElementSibling;
          else article.insertBefore(w, cursor);
        }
        for (const w of fresh) observer.observe(w);
        await settle(fresh, theme);
        const rects = wrappers().map((w) => {
          const e = extent(w);
          heights.set(w, e.bottom - e.top);
          return [e.top, e.bottom - e.top];
        });
        return { rects, docHeight: document.body.scrollHeight };
      } finally {
        syncing = false;
      }
    },
    rect(first, last) {
      const all = wrappers();
      const nth = ([key, n]) => all.filter((w) => w.dataset.key === key)[n];
      const a = nth(first);
      const b = nth(last);
      if (!a || !b) return null;
      const from = all.indexOf(a);
      const to = all.indexOf(b);
      if (to < from) return null;
      let top = Infinity;
      let bottom = -Infinity;
      for (let i = from; i <= to; i++) {
        const e = extent(all[i]);
        if (e.bottom - e.top <= 0) continue;
        top = Math.min(top, e.top);
        bottom = Math.max(bottom, e.bottom);
      }
      return top < bottom ? { top, bottom } : null;
    },
  };
})
`;

function shellHtml(mdDir: string, assets: Assets, nonce: string): string {
  const base = documentBaseUrl(mdDir).href;
  const href = (p: string) => pathToFileURL(p).href;
  const config = {
    mermaidJs: href(assets.mermaidJs),
    nonce,
    background: PAGE_BACKGROUND,
    fontsMs: STABLE_FONTS_MS,
    imagesMs: STABLE_IMG_DECODE_MS,
    mermaidMs: STABLE_MERMAID_MS,
    reflowMs: REFLOW_DEBOUNCE_MS,
  };
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy(nonce)}">
<base href="${base}">
<link id="mdpx-light" rel="stylesheet" href="${href(assets.githubMarkdownCss.light)}">
<link id="mdpx-dark" rel="stylesheet" href="${href(assets.githubMarkdownCss.dark)}" disabled>
<link rel="stylesheet" href="${href(assets.katexCss)}">
<style>
  html, body { margin: 0; padding: 0; }
  html { background: ${PAGE_BACKGROUND.light}; }
  .markdown-body { box-sizing: border-box; min-width: 200px; max-width: ${ARTICLE_MAX_WIDTH_CSS}px; margin: 0 auto; padding: 32px; }
  .markdown-body > .mdpx-block:first-child > :first-child { margin-top: 0 !important; }
  .markdown-body > .mdpx-block:last-child > :last-child { margin-bottom: 0 !important; }
</style>
</head>
<body>
<article class="markdown-body"></article>
<script nonce="${nonce}">${RUNTIME}(${JSON.stringify(config)});</script>
</body>
</html>
`;
}

export class Page {
  private viewport: { widthCssPx: number; deviceScaleFactor: number } | null = null;
  private held = new Map<string, number>();

  private constructor(private readonly page: BrowserPage) {}

  static async open(
    page: BrowserPage,
    options: { mdDir: string; assets: Assets; dir: string; onReflow: () => void },
  ): Promise<Page> {
    const shellPath = join(options.dir, "shell.html");
    await writeFile(shellPath, shellHtml(options.mdDir, options.assets, randomUUID()));
    await page.exposeFunction("__mdpxReflow", options.onReflow);
    await page.goto(pathToFileURL(shellPath).href, { waitUntil: "load", timeout: NAV_TIMEOUT_MS });
    return new Page(page);
  }

  async sync(doc: Doc, geometry: Geometry): Promise<SyncedLayout> {
    const { viewportWidthCssPx: widthCssPx, deviceScaleFactor } = geometry;
    if (this.viewport?.widthCssPx !== widthCssPx || this.viewport.deviceScaleFactor !== deviceScaleFactor) {
      await this.page.setViewport({ width: widthCssPx, height: VIEWPORT_HEIGHT_CSS_PX, deviceScaleFactor });
      this.viewport = { widthCssPx, deviceScaleFactor };
    }
    const held = this.held;
    this.held = new Map();
    const send = (resend: ReadonlySet<string>) => {
      const seen = new Map<string, number>();
      const blocks = doc.blocks.map((b): SyncBlock => {
        const n = seen.get(b.key) ?? 0;
        seen.set(b.key, n + 1);
        return n < (held.get(b.key) ?? 0) && !resend.has(b.key) ? { key: b.key } : { key: b.key, html: b.html };
      });
      return this.page.evaluate((b, theme) => window.__mdpx.sync(b, theme), blocks, doc.theme);
    };
    let result = await send(new Set());
    if ("missing" in result) result = await send(new Set(result.missing));
    if ("missing" in result) throw new Error(`the page lost blocks it was just sent: ${result.missing.join(", ")}`);
    for (const b of doc.blocks) this.held.set(b.key, (this.held.get(b.key) ?? 0) + 1);
    return {
      raster: geometry.raster,
      theme: doc.theme,
      blocks: doc.blocks.map((b, i) => ({
        key: b.key,
        topCss: result.rects[i]![0],
        heightCss: result.rects[i]![1],
      })),
      docHeightCss: result.docHeight,
    };
  }

  async capture(ref: CaptureRef): Promise<Capture> {
    const viewport = this.viewport;
    if (!viewport) throw new CaptureGone("the page has not been synced");
    const rect = await this.page.evaluate(
      (first, last) => window.__mdpx.rect(first, last),
      [ref.first.key, ref.first.occurrence] as [string, number],
      [ref.last.key, ref.last.occurrence] as [string, number],
    );
    const dsf = viewport.deviceScaleFactor;
    if (!rect || Math.round((rect.bottom - rect.top) * dsf) !== ref.runHeightImgPx) {
      throw new CaptureGone("the blocks are gone or have another height than when they were laid out");
    }
    const contentTop = rect.top + ref.offsetCss;
    const { topCss: top, bottomCss: bottom } = captureClipCss(contentTop, ref.lengthCss, dsf);
    let pngBase64: string;
    try {
      pngBase64 = await this.page.screenshot({
        clip: { x: 0, y: top, width: viewport.widthCssPx, height: bottom - top },
        optimizeForSpeed: true,
        encoding: "base64",
      });
    } catch (e) {
      if (this.page.isClosed() || !this.page.browser().connected) throw e;
      throw new CaptureFailed(e instanceof Error ? e.message : String(e), { cause: e });
    }
    return { pngBase64, contentTopImgPx: (contentTop - top) * dsf, heightImgPx: Math.round((bottom - top) * dsf) };
  }
}
