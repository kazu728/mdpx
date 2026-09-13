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

async function build(markdown: string = MD, theme: Theme = "light", mdDir = "/tmp/docs") {
  return buildHtml({ markdown, mdDir, assets: resolveAssets(theme), theme });
}

describe("buildHtml", () => {
  test("mermaid fence becomes <pre class=\"mermaid\">", async () => {
    const { html } = await build();
    expect(html).toContain('<pre class="mermaid" data-source-line="5">graph TD; A--&gt;B\n</pre>');
    expect(html).not.toContain('<pre class="shiki"');
  });

  test("<base> points at the md directory", async () => {
    const { html } = await build(MD, "light", "/tmp/docs");
    expect(html).toContain(`<base href="${pathToFileURL("/tmp/docs").href}/">`);
  });

  test("KaTeX is rendered server-side", async () => {
    expect((await build()).html).toMatch(/class="katex/);
  });

  test("file:// CSS/JS refs exist", async () => {
    const { html } = await build();
    const urls = [...html.matchAll(/(?:href|src)="(file:\/\/[^"]+)"/g)].map((m) => m[1]!);
    const refs = urls.filter((u) => u.includes("/node_modules/"));
    expect(refs.length).toBeGreaterThanOrEqual(3);
    for (const u of refs) expect(existsSync(fileURLToPath(u))).toBe(true);
  });

  test("shiki pre has inline styles without background, loads on demand", async () => {
    const { html } = await build();
    const preTag = html.match(/<pre\b[^>]*class="shiki[^>]*>/)?.[0];
    expect(preTag).toBeDefined();
    expect(preTag).not.toContain("background-color");
    expect(html).toMatch(/<span style="color:/);
    expect((await build("```rust\nfn main() {}\n```\n")).html).toMatch(/<span style="color:/);
  });

  test("theme stays consistent (light/dark) without leaking", async () => {
    for (const theme of ["light", "dark"] as const) {
      const { html } = await build(MD, theme);
      expect(html).toContain(theme === "light" ? "github-markdown-light.css" : "github-markdown-dark.css");
      expect(html).toMatch(theme === "light" ? /<pre class="shiki github-light/ : /<pre class="shiki github-dark/);
      expect(html).toContain(theme === "light" ? "background: #ffffff" : "background: #0d1117");
    }
  });

  test("body meta refresh is neutralized", async () => {
    const { html } = await build('<meta http-equiv="refresh" content="0;url=https://example.com/land">\n');
    expect(html).not.toMatch(/<meta\b[^>]*http-equiv="refresh"/i);
    expect(html).toMatch(/&lt;meta/i);
    const { html: nested } = await build('<<meta>meta http-equiv="refresh" content="0;url=https://example.com">\n');
    expect(nested).not.toMatch(/<meta\b[^>]*refresh/i);
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
    const { html } = await build(ANCHOR_MD);
    return [...html.matchAll(/<(\w+)\b[^>]*\sdata-source-line="(\d+)"/g)].map((m) => [m[1]!, m[2]!] as [string, string]);
  }

  test("blocks carry 1-based lines", async () => {
    const found = await anchors();
    for (const pair of [["h1", "1"], ["p", "3"], ["blockquote", "5"], ["ul", "19"], ["li", "19"], ["li", "20"]])
      expect(found).toContainEqual(pair as [string, string]);
  });

  test("fences anchor on pre (shiki + mermaid)", async () => {
    const found = await anchors();
    expect(found).toContainEqual(["pre", "7"]);
    expect(found).toContainEqual(["pre", "11"]);
  });

  test("math_block has none", async () => {
    expect((await anchors()).map(([, line]) => line)).not.toContain("15");
  });

  test("non-decreasing in document order", async () => {
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

  test("covers only lines with rendered height", async () => {
    const { laidOutSourceLines } = await build(LAYOUT_MD);
    const lines = [...laidOutSourceLines];
    expect(lines).toHaveLength(14);
    expect(lines).toEqual(expect.arrayContaining([1, 3, 4, 6, 8, 11, 23]));
    expect(lines).toEqual([...lines].sort((a, b) => a - b));
    expect(lines[0]).toBe(1);
    expect(lines.at(-1)).toBe(23);
  });

  test("unclosed fence keeps its last row", async () => {
    const { laidOutSourceLines } = await build(["```ts", "a", "", "b"].join("\n"));
    expect([...laidOutSourceLines]).toEqual([2, 3, 4]);
  });
});
