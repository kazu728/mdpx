import { describe, expect, test } from "bun:test";
import { pathToFileURL } from "node:url";
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
    expect(html).toContain('<pre class="mermaid">graph TD; A--&gt;B\n</pre>');
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
