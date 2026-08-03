// markdown → a complete HTML document (§4.2). String generation only (no terminal or fs I/O).
//
// - markdown-it (tables and strikethrough are built in, task lists come from a plugin)
// - KaTeX rendered server-side (@vscode/markdown-it-katex calls renderToString during render)
// - code highlighted server-side by shiki (inline styles, theme follows the effective theme)
// - mermaid fences become <pre class="mermaid"> and are drawn in the page (injected only when used)
// - block tokens get data-source-line (1-based) for §4.9's line anchors (no effect on rendering)
// - CSP: disables markdown-derived JS and blocks outbound traffic; only mermaid is allowed via nonce/file:
// CSS and JS are referenced through file:// link/script at the absolute paths the caller resolved.

import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import MarkdownIt from "markdown-it";
import taskLists from "markdown-it-task-lists";
import katex from "@vscode/markdown-it-katex";
import { createHighlighter, type Highlighter, type ShikiTransformer } from "shiki";
import type { Assets } from "./assets.ts";
import { countLines } from "./linemap.ts";
import type { Theme } from "./theme.ts";

/** markdown-it ships no types and @types does not export this one either, so take it from parse's return. */
type Token = ReturnType<MarkdownIt["parse"]>[number];

// Per-theme rendering settings, keeping the shiki theme, the page background, and mermaid's theme in step.
const SHIKI_THEME: Record<Theme, string> = { light: "github-light", dark: "github-dark" };
const PAGE_BG: Record<Theme, string> = { light: "#ffffff", dark: "#0d1117" };
const MERMAID_THEME: Record<Theme, string> = { light: "default", dark: "dark" };

// shiki writes background-color straight onto the <pre>, cancelling github-markdown-css's code block
// background (its themed box, rounded corners, and padding). Strip just the background colour to
// keep GitHub's box. The order of declarations is an internal shiki detail, so this drops every
// background-color regardless of position rather than assuming one.
const dropShikiBackground: ShikiTransformer = {
  pre(node) {
    const style = node.properties.style;
    if (typeof style === "string") {
      node.properties.style = style.replace(/background-color:[^;]*;?/g, "").trim();
    }
  },
};

/**
 * Source line anchor (§4.9). markdown-it's token.map is 0-based [start, end), so +1 makes it
 * 1-based — the same basis as nvim's line numbers, which removes the conversion on the sending side.
 */
const SOURCE_LINE = "data-source-line";

/** Attach the line anchor to fences on the shiki path. No regex injection into the HTML string. */
const sourceLineAttr = (line: string): ShikiTransformer => ({
  pre(node) {
    node.properties[SOURCE_LINE] = line;
  },
});

// Languages loaded for server-side rendering. codeToHtml throws on an unknown language, so fall back to text.
const LANGS = [
  "bash", "c", "cpp", "css", "diff", "dockerfile", "go", "graphql", "html",
  "java", "javascript", "json", "jsonc", "jsx", "kotlin", "lua", "make",
  "markdown", "nix", "php", "python", "ruby", "rust", "scala", "sql", "swift",
  "toml", "tsx", "typescript", "xml", "yaml",
];

// Building the highlighter loads wasm and grammars, so it is created once per process and reused
// (rebuilding it on every reload is slow). A rejected promise is not cached, so the next reload retries.
let highlighterPromise: Promise<Highlighter> | null = null;
function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    // Load both the light and dark themes so the render can pick either.
    highlighterPromise = createHighlighter({
      themes: Object.values(SHIKI_THEME),
      langs: LANGS,
    }).catch((e) => {
      highlighterPromise = null; // never cache a failure forever (allow recovery from a transient one)
      throw e;
    });
  }
  return highlighterPromise;
}

/**
 * Strip <meta> from the markdown body (the raw HTML let through by html: true).
 * Chrome honours <meta http-equiv="refresh"> even inside body, and CSP cannot stop a top-level
 * navigation (a meta-delivered CSP has its sandbox directive ignored too). The destination does not
 * inherit our CSP, which opens the door to arbitrary JS on an attacker origin, egress, and display
 * spoofing — so it is dropped at the entrance. Code in the body is already escaped by markdown-it
 * (&lt;meta) and therefore never matches here.
 */
function stripMetaTags(html: string): string {
  return html.replace(/<meta\b[^>]*>/gi, "");
}

/** md.render's env. The renderer reports whether a mermaid fence appeared (which decides bundle injection). */
interface RenderEnv {
  hasMermaid?: boolean;
}

// MarkdownIt, plugin registration included, is built once per theme and reused (the theme is fixed at
// startup, so effectively one instance; this avoids rebuilding it on every reload).
const rendererCache = new Map<Theme, MarkdownIt>();
function getRenderer(theme: Theme, highlighter: Highlighter): MarkdownIt {
  const cached = rendererCache.get(theme);
  if (cached) return cached;

  const md = new MarkdownIt({ html: true, linkify: true });
  md.use(taskLists);
  md.use(katex);

  // Attach line anchors to block tokens (§4.9). Only block tokens carry a map; closing tokens and
  // inline tokens have a null map and pass straight through.
  // fence and math_block never reach here because a custom rule and a plugin render them — fence gets
  // its anchor below, and math_block stays anchorless, interpolated from its neighbours.
  const renderToken = md.renderer.renderToken.bind(md.renderer);
  md.renderer.renderToken = (tokens, idx, options) => {
    const token = tokens[idx]!;
    if (token.nesting === 1 && token.map) token.attrSet(SOURCE_LINE, String(token.map[0]! + 1));
    return renderToken(tokens, idx, options);
  };

  const escape = md.utils.escapeHtml;
  md.renderer.rules.fence = (tokens, idx, _options, env: RenderEnv) => {
    const token = tokens[idx]!;
    const lang = token.info.trim().split(/\s+/g)[0] ?? "";
    const line = token.map ? String(token.map[0]! + 1) : null;
    if (lang === "mermaid") {
      env.hasMermaid = true;
      const anchor = line ? ` ${SOURCE_LINE}="${line}"` : "";
      return `<pre class="mermaid"${anchor}>${escape(token.content)}</pre>\n`;
    }
    const transformers = line
      ? [dropShikiBackground, sourceLineAttr(line)]
      : [dropShikiBackground];
    const toHtml = (l: string) =>
      highlighter.codeToHtml(token.content, {
        lang: l,
        theme: SHIKI_THEME[theme],
        transformers,
      });
    try {
      return toHtml(lang || "text") + "\n";
    } catch {
      return toHtml("text") + "\n";
    }
  };

  rendererCache.set(theme, md);
  return md;
}

/**
 * Whether a source line occupies height when rendered (1-based; index 0 is unused). Used to narrow
 * §4.9's landing point.
 *
 * Blank lines between blocks, a fence's ``` lines, and a table's separator row each take a line in
 * the source but have no counterpart in the rendering. Interpolating px between anchors by line count
 * hands them px too, which slides the landing point one line past the line being read (measured: 80%
 * of the drift). Dropping them here keeps lineAt from ever choosing them.
 *
 * Only **the innermost token responsible for a line** paints its map; a token with map-bearing
 * descendants (a container such as table_open or list_item_open) leaves it to its children. The
 * table separator row falling out is merely a consequence of that rule — the tr_open responsible for
 * a row does not span the separator, and only the container table_open does.
 */
function laidOutLines(tokens: readonly Token[], lineCount: number): boolean[] {
  const out = new Array<boolean>(lineCount + 1).fill(false);
  const mark = (from: number, to: number) => {
    for (let l = Math.max(1, from); l <= Math.min(lineCount, to); l++) out[l] = true;
  };
  // A token still open when a map-bearing token appears inside it is a container
  const container = new Array<boolean>(tokens.length).fill(false);
  const open: number[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.nesting === -1) {
      open.pop();
      continue;
    }
    if (token.map) for (const j of open) container[j] = true;
    if (token.nesting === 1) open.push(i);
  }
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (!token.map || container[i]) continue;
    const start = token.map[0] + 1;
    if (token.type === "fence") {
      // The map spans the opening and closing ```. Count the inner lines from content instead (which
      // also holds for an unclosed fence)
      mark(start + 1, start + token.content.split("\n").length - 1);
    } else {
      mark(start, token.map[1]);
    }
  }
  return out;
}

// CSP: <script>, on* handlers, and javascript: inside the markdown body's raw HTML match neither the
// nonce nor the allowlist and are therefore inert. Only mermaid's file:// bundle and its nonced
// initializer are allowed.
// Putting file: in script-src would let external JS under the md directory the <base> points at
// (<script src="./x.js">) run without a nonce, breaking SPEC's "scripts from the body are inert"
// trust boundary. Only the nonce is allowed and file: is left out (the mermaid bundle is a nonced
// script, so it loads from file:// regardless).
// connect-src 'none' blocks fetch/XHR/beacon/WebSocket. CSP only governs subresource fetches though:
// <img> follows img-src (http/https allowed for SPEC's remote image support), and no directive stops
// a top-level navigation — that entrance is closed by stripMetaTags.
function contentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'none'",
    // Only the nonce is allowed; no eval-permitting source expression. mermaid 11 does not need eval
    // (measured: zero CSP violations across 8 diagram types), and adding one would only widen the
    // damage should a body-derived script ever obtain the nonce. If a future mermaid goes back to
    // needing eval, the `.mermaid svg` assertion in chrome.integration.test.ts fails and says so.
    `script-src 'nonce-${nonce}'`,
    "style-src 'unsafe-inline' file:",
    "img-src file: data: https: http:",
    "font-src file:",
    "connect-src 'none'",
    "base-uri file:", // allow our own file:// base while blocking relative-URL hijacking via <base href="http://…"> in the body
  ].join("; ");
}

export interface BuildHtmlInput {
  markdown: string;
  /** Absolute path of the directory holding the .md file. Used as <base> to resolve relative images. */
  mdDir: string;
  assets: Assets;
  /** Effective theme, keeping shiki, the page background, and mermaid in step (the assets' CSS matches it too). */
  theme: Theme;
}

export interface BuildHtmlResult {
  html: string;
  /** Whether each source line occupies height when rendered (1-based). Passed to linemap to narrow §4.9's landing point. */
  laidOut: readonly boolean[];
}

export async function buildHtml(input: BuildHtmlInput): Promise<BuildHtmlResult> {
  const highlighter = await getHighlighter();
  const md = getRenderer(input.theme, highlighter);

  // md.render is equivalent to parse → renderer.render. The two are called separately because the
  // token stream is needed to work out which token is responsible for which line
  const env: RenderEnv = {};
  const tokens = md.parse(input.markdown, env);
  const body = stripMetaTags(md.renderer.render(tokens, md.options, env));

  let base = pathToFileURL(input.mdDir).href;
  if (!base.endsWith("/")) base += "/";
  const href = (p: string) => pathToFileURL(p).href;

  const nonce = randomUUID();
  // With no mermaid syntax the 3.4MB bundle is not injected. initialize sits inside the try, and
  // __mermaidDone is set even on failure so the wait for a stable render (3s cap) is not burned.
  const mermaid = env.hasMermaid
    ? `<script src="${href(input.assets.mermaidJs)}" nonce="${nonce}"></script>
<script nonce="${nonce}">
  (async () => {
    try {
      mermaid.initialize({ startOnLoad: false, theme: "${MERMAID_THEME[input.theme]}" });
      await mermaid.run();
    } catch (e) {}
    window.__mermaidDone = true;
  })();
</script>`
    : `<script nonce="${nonce}">window.__mermaidDone = true;</script>`;

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy(nonce)}">
<base href="${base}">
<link rel="stylesheet" href="${href(input.assets.githubMarkdownCss)}">
<link rel="stylesheet" href="${href(input.assets.katexCss)}">
<style>
  html, body { margin: 0; padding: 0; background: ${PAGE_BG[input.theme]}; }
  .markdown-body { box-sizing: border-box; min-width: 200px; max-width: 980px; margin: 0 auto; padding: 32px; }
</style>
</head>
<body>
<article class="markdown-body">
${body}</article>
${mermaid}
</body>
</html>
`;
  return { html, laidOut: laidOutLines(tokens, countLines(input.markdown)) };
}
