import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildHtml, resolveAssets, type Theme } from "./html.ts";

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
    expect(fileRefs.length).toBeGreaterThanOrEqual(3);
    for (const u of fileRefs) expect(existsSync(fileURLToPath(u))).toBe(true);
  });

  test("shiki renders code server-side with inline styles (the pre background is stripped to keep GitHub's box)", async () => {
    const html = await build("/tmp/docs");
    const preTag = html.match(/<pre\b[^>]*class="shiki[^>]*>/)?.[0];
    expect(preTag).toBeDefined();
    expect(preTag).not.toContain("background-color");
    expect(html).toMatch(/<span style="color:/);
  });

  test("a configured language not used earlier is loaded when its fence appears", async () => {
    const { html } = await buildHtml({
      markdown: "```rust\nfn main() {}\n```\n",
      mdDir: "/tmp/docs",
      assets: resolveAssets("light"),
      theme: "light",
    });
    expect(html).toMatch(/<pre class="shiki github-light/);
    expect(html).toMatch(/<span style="color:/);
  });

  test("light keeps shiki, the background, mermaid, and the CSS all light", async () => {
    const html = await build("/tmp/docs", "light");
    expect(html).toContain("github-markdown-light.css");
    expect(html).toMatch(/<pre class="shiki github-light/);
    expect(html).toContain("background: #ffffff");
    expect(html).toContain('theme: "default"');
  });

  test("dark keeps shiki, the background, mermaid, and the CSS all dark", async () => {
    const html = await build("/tmp/docs", "dark");
    expect(html).toContain("github-markdown-dark.css");
    expect(html).toMatch(/<pre class="shiki github-dark/);
    expect(html).toContain("background: #0d1117");
    expect(html).toContain('theme: "dark"');
  });

  test("alternating themes through the shared renderer do not leak", async () => {
    expect(await build("/tmp/docs", "dark")).toMatch(/<pre class="shiki github-dark/);
    expect(await build("/tmp/docs", "light")).toMatch(/<pre class="shiki github-light/);
  });
});

describe("data-source-line", () => {
  const ANCHOR_MD = [
    "# h1",
    "",
    "para",
    "",
    "> quote",
    "",
    "```ts",
    "const x = 1;",
    "```",
    "",
    "```mermaid",
    "graph TD; A-->B",
    "```",
    "",
    "$$",
    "E = mc^2",
    "$$",
    "",
    "- item",
    "  - nested",
  ].join("\n");

  async function anchors(): Promise<[string, string][]> {
    const { html } = await buildHtml({
      markdown: ANCHOR_MD,
      mdDir: "/tmp/docs",
      assets: resolveAssets("light"),
      theme: "light",
    });
    return [...html.matchAll(/<(\w+)\b[^>]*\sdata-source-line="(\d+)"/g)].map((m) => [m[1]!, m[2]!]);
  }

  test("block tokens carry a 1-based line number", async () => {
    const found = await anchors();
    expect(found).toContainEqual(["h1", "1"]);
    expect(found).toContainEqual(["p", "3"]);
    expect(found).toContainEqual(["blockquote", "5"]);
    expect(found).toContainEqual(["ul", "19"]);
    expect(found).toContainEqual(["li", "19"]);
    expect(found).toContainEqual(["li", "20"]);
  });

  test("fences get theirs on the pre, on both the shiki and mermaid paths", async () => {
    const found = await anchors();
    expect(found).toContainEqual(["pre", "7"]);
    expect(found).toContainEqual(["pre", "11"]);
  });

  test("math_block gets none (interpolation from its neighbours absorbs it)", async () => {
    const found = await anchors();
    expect(found.map(([, line]) => line)).not.toContain("15");
  });

  test("never goes backwards in document order (non-decreasing)", async () => {
    const lines = (await anchors()).map(([, line]) => Number(line));
    expect(lines).toEqual([...lines].sort((a, b) => a - b));
  });
});

describe("laidOutSourceLines", () => {
  const LAYOUT_MD = [
    "# h1",
    "",
    "para1",
    "para2",
    "",
    "| a | b |",
    "|---|---|",
    "| c | d |",
    "",
    "```ts",
    "const x = 1;",
    "",
    "const y = 2;",
    "```",
    "",
    "$$",
    "E = mc^2",
    "$$",
    "",
    "- item",
    "  continued",
    "",
    "last",
  ].join("\n");

  test("only lines that occupy height when rendered are true", async () => {
    const { laidOutSourceLines } = await buildHtml({
      markdown: LAYOUT_MD,
      mdDir: "/tmp/docs",
      assets: resolveAssets("light"),
      theme: "light",
    });
    expect([...laidOutSourceLines]).toEqual([
      1, 3, 4, 6, 8, 11, 12, 13, 16, 17, 18, 20, 21, 23,
    ]);
  });

  test("a fence left unclosed at the end of the file keeps its last row", async () => {
    const { laidOutSourceLines } = await buildHtml({
      markdown: ["```ts", "a", "", "b"].join("\n"),
      mdDir: "/tmp/docs",
      assets: resolveAssets("light"),
      theme: "light",
    });
    expect([...laidOutSourceLines]).toEqual([2, 3, 4]);
  });
});
