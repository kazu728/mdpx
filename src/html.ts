import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import MarkdownIt from "markdown-it";
import taskLists from "markdown-it-task-lists";
import katex from "@vscode/markdown-it-katex";
import { createHighlighter, type Highlighter, type ShikiTransformer } from "shiki";
import type { Assets } from "./assets.ts";
import { countSourceLines } from "./linemap.ts";
import type { Theme } from "./theme.ts";

type Token = ReturnType<MarkdownIt["parse"]>[number];

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

const SOURCE_LINE = "data-source-line";

const sourceLineAttr = (line: string): ShikiTransformer => ({
  pre(node) {
    node.properties[SOURCE_LINE] = line;
  },
});

const LANGS = [
  "bash", "c", "cpp", "css", "diff", "dockerfile", "go", "graphql", "html",
  "java", "javascript", "json", "jsonc", "jsx", "kotlin", "lua", "make",
  "markdown", "nix", "php", "python", "ruby", "rust", "scala", "sql", "swift",
  "toml", "tsx", "typescript", "xml", "yaml",
];

let highlighterPromise: Promise<Highlighter> | null = null;
function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: Object.values(SHIKI_THEME),
      langs: LANGS,
    }).catch((e) => {
      highlighterPromise = null;
      throw e;
    });
  }
  return highlighterPromise;
}

/** Remove body meta tags so a meta refresh cannot navigate outside this document's CSP. */
function stripMetaTags(html: string): string {
  return html.replace(/<meta\b[^>]*>/gi, "");
}

interface RenderEnv {
  hasMermaid?: boolean;
}

const rendererCache = new Map<Theme, MarkdownIt>();
function getRenderer(theme: Theme, highlighter: Highlighter): MarkdownIt {
  const cached = rendererCache.get(theme);
  if (cached) return cached;

  const md = new MarkdownIt({ html: true, linkify: true });
  md.use(taskLists);
  md.use(katex);

  // Attach source-line anchors to block tokens; fences are handled by the custom renderer below.
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

/** Keep only source lines with rendered height, using the innermost mapped token for each line. */
function findLaidOutSourceLines(tokens: readonly Token[], sourceLineCount: number): Set<number> {
  const sourceLines = new Set<number>();
  const mark = (from: number, to: number) => {
    for (let line = Math.max(1, from); line <= Math.min(sourceLineCount, to); line++) {
      sourceLines.add(line);
    }
  };
  const isContainer = new Array<boolean>(tokens.length).fill(false);
  const open: number[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.nesting === -1) {
      open.pop();
      continue;
    }
    if (token.map) for (const j of open) isContainer[j] = true;
    if (token.nesting === 1) open.push(i);
  }
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (!token.map || isContainer[i]) continue;
    const start = token.map[0] + 1;
    if (token.type === "fence") {
      // The token map includes the fence delimiters; count rendered content instead.
      mark(start + 1, start + token.content.split("\n").length - 1);
    } else {
      mark(start, token.map[1]);
    }
  }
  return sourceLines;
}

// Body scripts lack the nonce and remain inert. Keep file: out of script-src so <base> cannot enable
// external body scripts; mermaid is loaded from file:// with the nonce. connect-src blocks network
// requests, and stripMetaTags closes top-level navigation.
function contentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'none'",
    // Mermaid does not require eval; allowing it would widen the damage from a compromised script.
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
  mdDir: string;
  assets: Assets;
  theme: Theme;
}

export interface BuildHtmlResult {
  html: string;
  laidOutSourceLines: ReadonlySet<number>;
}

export async function buildHtml(input: BuildHtmlInput): Promise<BuildHtmlResult> {
  const highlighter = await getHighlighter();
  const md = getRenderer(input.theme, highlighter);

  const env: RenderEnv = {};
  const tokens = md.parse(input.markdown, env);
  const body = stripMetaTags(md.renderer.render(tokens, md.options, env));

  let base = pathToFileURL(input.mdDir).href;
  if (!base.endsWith("/")) base += "/";
  const href = (p: string) => pathToFileURL(p).href;

  const nonce = randomUUID();
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
  return {
    html,
    laidOutSourceLines: findLaidOutSourceLines(tokens, countSourceLines(input.markdown)),
  };
}
