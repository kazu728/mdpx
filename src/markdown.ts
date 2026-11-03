import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import katex from "katex";
import markdownit, { type MarkdownIt, type Token } from "markdown-it";
import { githubAlerts } from "./alerts.ts";
import type { Theme } from "./theme.ts";
import taskLists from "markdown-it-task-lists";
import {
  bundledLanguagesInfo,
  createHighlighter,
  type BundledLanguage,
  type Highlighter,
} from "shiki";

const require = createRequire(import.meta.url);

const markdownItKatex: (md: MarkdownIt, options: { katex: typeof katex; strict: boolean }) => void = require(
  "@vscode/markdown-it-katex",
).default;

export interface Block {
  readonly key: string;
  readonly html: string;
}

export interface Doc {
  readonly theme: Theme;
  readonly blocks: readonly Block[];
}

const SHIKI_THEME: Record<Theme, string> = { light: "github-light", dark: "github-dark" };

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

interface Renderer {
  highlighter: Highlighter;
  md: Record<Theme, MarkdownIt>;
}

let rendererPromise: Promise<Renderer> | null = null;
function getRenderer(): Promise<Renderer> {
  return (rendererPromise ??= createHighlighter({
    themes: Object.values(SHIKI_THEME),
    langs: [],
  }).then((highlighter) => ({
    highlighter,
    md: { light: createMarkdown(highlighter, "light"), dark: createMarkdown(highlighter, "dark") },
  })));
}

/** Escaping (not deleting) keeps `<<meta>meta ...>` from becoming a tag. */
function escapeMetaTags(html: string): string {
  return html.replace(/<(\/?)(meta)\b/gi, (_m, slash: string, word: string) => `&lt;${slash}${word}`);
}

function fenceLanguage(token: Token): string {
  return token.info.trim().split(/\s+/g)[0]!;
}

function createMarkdown(highlighter: Highlighter, theme: Theme): MarkdownIt {
  const md = markdownit({ html: true, linkify: true });
  md.linkify.set({ urlAuth: true });
  md.use(taskLists);
  md.use(githubAlerts);
  md.use(markdownItKatex, { katex, strict: false });

  const escape = md.utils.escapeHtml;
  md.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const token = tokens[idx]!;
    const lang = fenceLanguage(token);
    if (lang === "mermaid") return `<pre class="mermaid">${escape(token.content)}</pre>\n`;
    if (lang === "math") return md.renderer.rules.math_block!(tokens, idx, options, env, self);
    const toHtml = (l: string) =>
      highlighter.codeToHtml(token.content, {
        lang: l,
        theme: SHIKI_THEME[theme],
        rootStyle: false,
      });
    try {
      return toHtml(lang || "text") + "\n";
    } catch {
      return toHtml("text") + "\n";
    }
  };

  return md;
}

function topLevelRanges(tokens: readonly Token[]): Token[][] {
  const ranges: Token[][] = [];
  let current: Token[] = [];
  let depth = 0;
  for (const token of tokens) {
    current.push(token);
    depth += token.nesting;
    if (depth === 0) {
      ranges.push(current);
      current = [];
    }
  }
  if (current.length) ranges.push(current);
  return ranges;
}

const VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr",
]);

function netOpenElements(html: string): number {
  let depth = 0;
  const withoutComments = html.replace(/<!--[\s\S]*?-->/g, "");
  for (const m of withoutComments.matchAll(/<(\/?)([a-zA-Z][\w-]*)\b[^>]*?(\/?)>/g)) {
    const [, closing, name, selfClosing] = m;
    if (VOID_ELEMENTS.has(name!.toLowerCase()) || selfClosing) continue;
    depth += closing ? -1 : 1;
  }
  return depth;
}

function groupOpenHtml(ranges: Token[][]): Token[][] {
  const groups: Token[][] = [];
  let open = 0;
  for (const range of ranges) {
    const html = range.filter((t) => t.type === "html_block").map((t) => t.content).join("");
    if (open > 0) groups.at(-1)!.push(...range);
    else groups.push([...range]);
    open = Math.max(0, open + netOpenElements(html));
  }
  return groups;
}

function imageSources(html: string): string[] {
  return Array.from(html.matchAll(/<img\b[^>]*?\ssrc="([^"]*)"/gi), (m) => m[1]!);
}

export function documentBaseUrl(mdDir: string): URL {
  const url = pathToFileURL(mdDir);
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}

async function imageVersions(html: string, mdDir: string): Promise<string> {
  const versions = await Promise.all(
    imageSources(html).map(async (src) => {
      // Resolved the way the page resolves it; a URL the browser cannot parse shows no image.
      let url: URL;
      try {
        url = new URL(src, documentBaseUrl(mdDir));
      } catch {
        return "";
      }
      if (url.protocol !== "file:") return "";
      try {
        const s = await stat(fileURLToPath(url));
        return `${s.mtimeMs}:${s.size}`;
      } catch {
        return "missing";
      }
    }),
  );
  return versions.join(",");
}

export async function renderDocument(
  markdown: string,
  options: { theme: Theme; mdDir: string },
): Promise<Doc> {
  const { highlighter, md: mdByTheme } = await getRenderer();
  const md = mdByTheme[options.theme];
  const tokens = md.parse(markdown, {});
  const languages = new Set<BundledLanguage>();
  for (const token of tokens) {
    if (token.type !== "fence") continue;
    const language = languageByName.get(fenceLanguage(token));
    if (language) languages.add(language);
  }
  if (languages.size > 0) await highlighter.loadLanguage(...languages);

  const blocks = await Promise.all(
    groupOpenHtml(topLevelRanges(tokens)).map(async (range): Promise<Block> => {
      const html = escapeMetaTags(md.renderer.render(range, md.options));
      const versions = await imageVersions(html, options.mdDir);
      const key = createHash("sha1")
        .update(`${options.theme}\0${html}\0${versions}`)
        .digest("base64url")
        .slice(0, 22);
      return { key, html };
    }),
  );
  return { theme: options.theme, blocks };
}
