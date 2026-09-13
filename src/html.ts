import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import MarkdownIt from "markdown-it";
import taskLists from "markdown-it-task-lists";
import {
  bundledLanguagesInfo,
  createHighlighter,
  type BundledLanguage,
  type Highlighter,
  type ShikiTransformer,
} from "shiki";
import { countSourceLines } from "./linemap.ts";

const require = createRequire(import.meta.url);

const katex: typeof import("@vscode/markdown-it-katex").default = require(
  "@vscode/markdown-it-katex",
).default;

export type Theme = "light" | "dark";

export interface Assets {
  githubMarkdownCss: string;
  katexCss: string;
  mermaidJs: string;
}

export function resolveAssets(theme: Theme): Assets {
  return {
    githubMarkdownCss: require.resolve(`github-markdown-css/github-markdown-${theme}.css`),
    katexCss: require.resolve("katex/dist/katex.min.css"),
    mermaidJs: require.resolve("mermaid/dist/mermaid.min.js"),
  };
}

type Token = ReturnType<MarkdownIt["parse"]>[number];

const SHIKI_THEME: Record<Theme, string> = { light: "github-light", dark: "github-dark" };
const PAGE_BG: Record<Theme, string> = { light: "#ffffff", dark: "#0d1117" };
const MERMAID_THEME: Record<Theme, string> = { light: "default", dark: "dark" };

// Keep github-markdown-css by stripping shiki's <pre> background.
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
] satisfies BundledLanguage[];

const languageByName = new Map<string, BundledLanguage>();
for (const info of bundledLanguagesInfo) {
  const names = [info.id, ...(info.aliases ?? [])];
  if (names.some((name) => (LANGS as readonly string[]).includes(name))) {
    for (const name of names) languageByName.set(name, info.id as BundledLanguage);
  }
}

let highlighterPromise: Promise<Highlighter> | null = null;
function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: Object.values(SHIKI_THEME),
      langs: [],
    }).catch((e) => {
      highlighterPromise = null;
      throw e;
    });
  }
  return highlighterPromise;
}

/** Escaping (not deleting) keeps `<<meta>meta ...>` from becoming a tag. */
function stripMetaTags(html: string): string {
  return html.replace(/<(\/?)(meta)\b/gi, (_m, slash: string, word: string) => `&lt;${slash}${word}`);
}

interface RenderEnv {
  theme: Theme;
  hasMermaid?: boolean;
}

function fenceLanguage(token: Token): string {
  return token.info.trim().split(/\s+/g)[0]!;
}

let rendererCache: MarkdownIt | null = null;
function getRenderer(highlighter: Highlighter): MarkdownIt {
  if (rendererCache) return rendererCache;

  const md = new MarkdownIt({ html: true, linkify: true });
  md.use(taskLists);
  md.use(katex);

  const renderToken = md.renderer.renderToken.bind(md.renderer);
  md.renderer.renderToken = (tokens, idx, options) => {
    const token = tokens[idx]!;
    if (token.nesting === 1 && token.map) token.attrSet(SOURCE_LINE, String(token.map[0]! + 1));
    return renderToken(tokens, idx, options);
  };

  const escape = md.utils.escapeHtml;
  md.renderer.rules.fence = (tokens, idx, _options, env: RenderEnv) => {
    const token = tokens[idx]!;
    const lang = fenceLanguage(token);
    const line = String(token.map![0] + 1);
    if (lang === "mermaid") {
      env.hasMermaid = true;
      return `<pre class="mermaid" ${SOURCE_LINE}="${line}">${escape(token.content)}</pre>\n`;
    }
    const toHtml = (l: string) =>
      highlighter.codeToHtml(token.content, {
        lang: l,
        theme: SHIKI_THEME[env.theme],
        transformers: [dropShikiBackground, sourceLineAttr(line)],
      });
    try {
      return toHtml(lang || "text") + "\n";
    } catch {
      return toHtml("text") + "\n";
    }
  };

  rendererCache = md;
  return md;
}

/** Only source lines with rendered height, via the innermost mapped token. */
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
      const rows = token.content.split("\n");
      mark(start + 1, start + (rows[rows.length - 1] === "" ? rows.length - 1 : rows.length));
    } else {
      mark(start, token.map[1]);
    }
  }
  return sourceLines;
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
  const md = getRenderer(highlighter);

  const env: RenderEnv = { theme: input.theme };
  const tokens = md.parse(input.markdown, env);
  const languages = new Set<BundledLanguage>();
  for (const token of tokens) {
    if (token.type !== "fence") continue;
    const language = languageByName.get(fenceLanguage(token));
    if (language) languages.add(language);
  }
  if (languages.size > 0) await highlighter.loadLanguage(...languages);
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
