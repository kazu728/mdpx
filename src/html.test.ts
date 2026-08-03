import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveAssets } from "./assets.ts";
import { buildHtml } from "./html.ts";
import type { Theme } from "./theme.ts";

// Snapshots would embed machine-specific file:// absolute paths, so these are structural assertions only (§7).
const MD = `# heading

$E = mc^2$

\`\`\`mermaid
graph TD; A-->B
\`\`\`

\`\`\`ts
const x: number = 1;
\`\`\`

![img](./pic.png)
`;

async function build(mdDir: string, theme: Theme = "light") {
  return (await buildHtml({ markdown: MD, mdDir, assets: resolveAssets(theme), theme })).html;
}

describe("buildHtml", () => {
  test("a mermaid fence becomes <pre class=\"mermaid\">", async () => {
    const html = await build("/tmp/docs");
    expect(html).toContain('<pre class="mermaid" data-source-line="5">graph TD; A--&gt;B\n</pre>');
    // Handled separately from shiki's code blocks (mermaid keeps the raw text so it can become SVG)
    expect(html).not.toContain('<pre class="shiki"');
  });

  test("<base> points at the md's directory", async () => {
    const dir = "/tmp/docs";
    const html = await build(dir);
    expect(html).toContain(`<base href="${pathToFileURL(dir).href}/">`);
  });

  test("KaTeX is rendered server-side (the output contains .katex)", async () => {
    const html = await build("/tmp/docs");
    expect(html).toMatch(/class="katex/);
  });

  test("the file:// references for CSS/JS point at paths that exist", async () => {
    const html = await build("/tmp/docs");
    const urls = [...html.matchAll(/(?:href|src)="(file:\/\/[^"]+)"/g)].map((m) => m[1]!);
    const fileRefs = urls.filter((u) => u.includes("/node_modules/"));
    expect(fileRefs.length).toBeGreaterThanOrEqual(3); // github-markdown-css, katex, mermaid
    for (const u of fileRefs) expect(existsSync(fileURLToPath(u))).toBe(true);
  });

  test("shiki renders code server-side with inline styles (the pre background is stripped to keep GitHub's box)", async () => {
    const html = await build("/tmp/docs");
    // Pick out shiki's opening pre tag without depending on attribute order
    const preTag = html.match(/<pre\b[^>]*class="shiki[^>]*>/)?.[0];
    expect(preTag).toBeDefined(); // a shiki-highlighted pre exists
    expect(preTag).not.toContain("background-color"); // no background burned into the pre (GitHub's light grey box shows through)
    expect(html).toMatch(/<span style="color:/); // token colours are inline
  });

  test("light uses the GitHub-light CSS and a white background", async () => {
    const html = await build("/tmp/docs", "light");
    expect(html).toContain("github-markdown-light.css");
    expect(html).toContain("background: #ffffff");
    expect(html).toMatch(/<pre class="shiki github-light/);
  });

  test("dark keeps shiki, the background, mermaid, and the CSS all dark", async () => {
    const html = await build("/tmp/docs", "dark");
    expect(html).toContain("github-markdown-dark.css"); // the dark GitHub CSS
    expect(html).toMatch(/<pre class="shiki github-dark/); // shiki's dark theme
    expect(html).toContain("background: #0d1117"); // dark page background
    expect(html).toContain('theme: "dark"'); // mermaid dark
  });
});

// §4.9's line anchors. Only "which tag points at which line" matters, not the opening tag's attribute order.
describe("data-source-line", () => {
  // A dedicated input laid out as one block per line plus blank lines, to make counting easy.
  const ANCHOR_MD = [
    "# h1", // 1
    "",
    "para", // 3
    "",
    "> quote", // 5
    "",
    "```ts", // 7
    "const x = 1;",
    "```",
    "",
    "```mermaid", // 11
    "graph TD; A-->B",
    "```",
    "",
    "$$", // 15 (math_block: no anchor)
    "E = mc^2",
    "$$",
    "",
    "- item", // 19
    "  - nested", // 20
  ].join("\n");

  async function anchors(): Promise<[string, string][]> {
    const { html } = await buildHtml({
      markdown: ANCHOR_MD,
      mdDir: "/tmp/docs",
      assets: resolveAssets("light"),
      theme: "light",
    });
    // Collect [tag name, line number] in document order
    return [...html.matchAll(/<(\w+)\b[^>]*\sdata-source-line="(\d+)"/g)].map((m) => [m[1]!, m[2]!]);
  }

  test("block tokens carry a 1-based line number", async () => {
    const found = await anchors();
    expect(found).toContainEqual(["h1", "1"]);
    expect(found).toContainEqual(["p", "3"]);
    expect(found).toContainEqual(["blockquote", "5"]);
    expect(found).toContainEqual(["ul", "19"]);
    expect(found).toContainEqual(["li", "19"]);
    expect(found).toContainEqual(["li", "20"]); // a nested item gets its own
  });

  test("fences get theirs on the pre, on both the shiki and mermaid paths", async () => {
    const found = await anchors();
    expect(found).toContainEqual(["pre", "7"]); // shiki (not an _open token, so it is attached by hand)
    expect(found).toContainEqual(["pre", "11"]); // mermaid
  });

  test("math_block gets none (interpolation from its neighbours absorbs it)", async () => {
    const found = await anchors();
    expect(found.map(([, line]) => line)).not.toContain("15");
  });

  // Duplicates pointing at the same line (a list_item and the paragraph inside it, say) do occur, so
  // this is not strictly monotonic. What matters here is that it never goes backwards in document
  // order — anything that does gets dropped when the LineMap is made monotonic
  test("never goes backwards in document order (non-decreasing)", async () => {
    const lines = (await anchors()).map(([, line]) => Number(line));
    expect(lines).toEqual([...lines].sort((a, b) => a - b));
  });
});

// §4.9's landing point narrowing: drop lines that take a line in the source but have no place in the rendering.
describe("laidOut", () => {
  const LAYOUT_MD = [
    "# h1", // 1
    "", // 2 blank line between blocks
    "para1", // 3
    "para2", // 4 (second line of the same paragraph)
    "", // 5
    "| a | b |", // 6
    "|---|---|", // 7 the table separator row (never rendered)
    "| c | d |", // 8
    "", // 9
    "```ts", // 10 fence opening
    "const x = 1;", // 11
    "", // 12 a blank line inside the fence (this one does occupy height)
    "const y = 2;", // 13
    "```", // 14 fence closing
    "", // 15
    "$$", // 16 math_block (custom renderer, no anchor)
    "E = mc^2", // 17
    "$$", // 18
    "", // 19
    "- item", // 20
    "  continued", // 21
    "", // 22
    "last", // 23
  ].join("\n");

  test("only lines that occupy height when rendered are true", async () => {
    const { laidOut } = await buildHtml({
      markdown: LAYOUT_MD,
      mdDir: "/tmp/docs",
      assets: resolveAssets("light"),
      theme: "light",
    });
    const on = laidOut.flatMap((v, line) => (v ? [line] : []));
    expect(on).toEqual([1, 3, 4, 6, 8, 11, 12, 13, 16, 17, 18, 20, 21, 23]);
  });
});
