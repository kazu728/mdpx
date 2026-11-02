import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import MarkdownIt from "markdown-it";
import taskLists from "markdown-it-task-lists";
import {
  bundledLanguagesInfo,
  createHighlighter,
  type BundledLanguage,
  type Highlighter,
  type ShikiTransformer,
} from "shiki";

const require = createRequire(import.meta.url);

const katex: typeof import("@vscode/markdown-it-katex").default = require(
  "@vscode/markdown-it-katex",
).default;

export type Theme = "light" | "dark";
export type BlockKind = "heading" | "other";

/** github-markdown-css's page background, also painted behind the images on rows they leave blank. */
export const PAGE_BACKGROUND: Record<Theme, string> = { light: "#ffffff", dark: "#0d1117" };

export interface Block {
  /**
   * Content identity: hash of the theme, the rendered HTML and the versions of the local
   * images it shows. Equal keys render equal pixels at the same raster spec. Hashing the
   * rendered HTML rather than the source means a changed reference-link definition re-keys
   * every paragraph that uses it.
   */
  readonly key: string;
  /** Self-contained: every element opened in it is closed in it. */
  readonly html: string;
  readonly kind: BlockKind;
}

export interface Doc {
  readonly theme: Theme;
  readonly blocks: readonly Block[];
}

type Token = ReturnType<MarkdownIt["parse"]>[number];

const SHIKI_THEME: Record<Theme, string> = { light: "github-light", dark: "github-dark" };

// Keep github-markdown-css by stripping shiki's <pre> background.
const dropShikiBackground: ShikiTransformer = {
  pre(node) {
    const style = node.properties.style;
    if (typeof style === "string") {
      node.properties.style = style.replace(/background-color:[^;]*;?/g, "").trim();
    }
  },
};

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
  md: MarkdownIt;
}

let rendererPromise: Promise<Renderer> | null = null;
function getRenderer(): Promise<Renderer> {
  return (rendererPromise ??= createHighlighter({
    themes: Object.values(SHIKI_THEME),
    langs: [],
  }).then((highlighter) => ({ highlighter, md: createMarkdown(highlighter) })));
}

/** Escaping (not deleting) keeps `<<meta>meta ...>` from becoming a tag. */
function stripMetaTags(html: string): string {
  return html.replace(/<(\/?)(meta)\b/gi, (_m, slash: string, word: string) => `&lt;${slash}${word}`);
}

interface RenderEnv {
  theme: Theme;
}

function fenceLanguage(token: Token): string {
  return token.info.trim().split(/\s+/g)[0]!;
}

function createMarkdown(highlighter: Highlighter): MarkdownIt {
  const md = new MarkdownIt({ html: true, linkify: true });
  md.use(taskLists);
  md.use(katex);

  const escape = md.utils.escapeHtml;
  md.renderer.rules.fence = (tokens, idx, _options, env: RenderEnv) => {
    const token = tokens[idx]!;
    const lang = fenceLanguage(token);
    if (lang === "mermaid") return `<pre class="mermaid">${escape(token.content)}</pre>\n`;
    const toHtml = (l: string) =>
      highlighter.codeToHtml(token.content, {
        lang: l,
        theme: SHIKI_THEME[env.theme],
        transformers: [dropShikiBackground],
      });
    try {
      return toHtml(lang || "text") + "\n";
    } catch {
      return toHtml("text") + "\n";
    }
  };

  return md;
}

/** Token ranges of the top-level blocks, in document order. */
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

/** Elements an HTML fragment leaves open (negative when it closes more than it opens). */
function openElements(html: string): number {
  let depth = 0;
  const withoutComments = html.replace(/<!--[\s\S]*?-->/g, "");
  for (const m of withoutComments.matchAll(/<(\/?)([a-zA-Z][\w-]*)\b[^>]*?(\/?)>/g)) {
    const [, closing, name, selfClosing] = m;
    if (VOID_ELEMENTS.has(name!.toLowerCase()) || selfClosing) continue;
    depth += closing ? -1 : 1;
  }
  return depth;
}

/**
 * Merges each raw HTML block that leaves elements open (`<details>`, `<div align=center>`)
 * with the blocks after it until they close, so every block can live in its own wrapper.
 */
function groupOpenHtml(ranges: Token[][]): Token[][] {
  const groups: Token[][] = [];
  let open = 0;
  for (const range of ranges) {
    const html = range.filter((t) => t.type === "html_block").map((t) => t.content).join("");
    if (open > 0) groups.at(-1)!.push(...range);
    else groups.push([...range]);
    open = Math.max(0, open + openElements(html));
  }
  return groups;
}

function imageSources(html: string): string[] {
  return Array.from(html.matchAll(/<img\b[^>]*?\ssrc="([^"]*)"/gi), (m) => m[1]!);
}

/** mtime and size of each local image, so overwriting the file re-keys the block. */
async function imageVersions(html: string, mdDir: string): Promise<string> {
  const versions = await Promise.all(
    imageSources(html).map(async (src) => {
      let path: string;
      if (/^file:/i.test(src)) path = fileURLToPath(src);
      else if (/^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith("//")) return "";
      else path = resolve(mdDir, decodeURI(src.split(/[?#]/)[0]!));
      try {
        const s = await stat(path);
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
  const { highlighter, md } = await getRenderer();
  const env: RenderEnv = { theme: options.theme };
  const tokens = md.parse(markdown, env);
  const languages = new Set<BundledLanguage>();
  for (const token of tokens) {
    if (token.type !== "fence") continue;
    const language = languageByName.get(fenceLanguage(token));
    if (language) languages.add(language);
  }
  if (languages.size > 0) await highlighter.loadLanguage(...languages);

  const blocks = await Promise.all(
    groupOpenHtml(topLevelRanges(tokens)).map(async (range): Promise<Block> => {
      const html = stripMetaTags(md.renderer.render(range, md.options, env));
      const versions = await imageVersions(html, options.mdDir);
      const key = createHash("sha1")
        .update(`${options.theme}\0${html}\0${versions}`)
        .digest("base64url")
        .slice(0, 22);
      return { key, html, kind: range[0]!.type === "heading_open" ? "heading" : "other" };
    }),
  );
  return { theme: options.theme, blocks };
}
