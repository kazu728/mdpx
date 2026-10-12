import { describe, expect, test } from "bun:test";
import { pathToFileURL } from "node:url";
import { buildHtml, resolveAssets, type Theme } from "./html.ts";

function build(markdown: string, theme: Theme = "light", mdDir = "/tmp/docs"): Promise<string> {
  return buildHtml({ markdown, mdDir, assets: resolveAssets(), theme });
}

describe("buildHtml", () => {
  test("mermaid fences are escaped and pages without diagrams skip mermaid.js", async () => {
    const html = await build("```mermaid\ngraph TD; A-->B\n```\n");
    expect(html).toContain('<pre class="mermaid">graph TD; A--&gt;B\n</pre>');

    const plain = await build("# no diagrams\n");
    expect(plain).not.toContain("mermaid.min.js");
    expect(plain).toContain("window.__mermaidDone = true;");
  });

  test("relative links resolve against the markdown directory", async () => {
    expect(await build("![img](./pic.png)\n", "light", "/tmp/docs")).toContain(
      `<base href="${pathToFileURL("/tmp/docs").href}/">`,
    );
  });

  test("renders math and code with matching page, syntax and diagram themes", async () => {
    const md = "$E = mc^2$\n\n```mermaid\ngraph TD; A-->B\n```\n\n" +
      "```rust\nfn main() {}\n```\n\n```ts\nlet x = 1;\n```\n\n```no-such-lang\nx\n```\n";
    const assets = resolveAssets();
    for (const [theme, background, diagramTheme] of [
      ["light", "#ffffff", "default"],
      ["dark", "#0d1117", "dark"],
    ] as const) {
      const html = await build(md, theme);
      expect(html).toMatch(/class="katex/);
      expect(html).toMatch(new RegExp(`<link rel="stylesheet" href="file:[^"]*github-markdown-${theme}\\.css">`));
      expect(html).toContain(`<link rel="stylesheet" href="${pathToFileURL(assets.katexCss).href}">`);
      const blocks = html.match(/<pre\b[^>]*class="shiki[\s\S]*?<\/pre>/g) ?? [];
      expect(blocks).toHaveLength(3);
      for (const block of blocks) {
        const pre = block.slice(0, block.indexOf(">"));
        expect(pre).toContain(`class="shiki github-${theme}`);
        expect(pre).not.toContain("background-color");
      }
      expect(blocks[0]).toMatch(/<span style="color:/);
      expect(blocks[1]).toMatch(/<span style="color:/);
      expect(html).toContain(`background: ${background}`);
      expect(html).toContain(`theme: "${diagramTheme}"`);
    }
  });

  test("meta tags in the body cannot redirect the page", async () => {
    const html = await build(
      '<meta http-equiv="refresh" content="0;url=https://example.com">\n\n' +
        '<<meta>meta http-equiv="refresh" content="0;url=https://example.com">\n',
    );
    const body = html.slice(html.indexOf("<body>"));
    expect(body).not.toMatch(/<meta\b/i);
    expect(body).toContain('&lt;meta http-equiv="refresh"');
  });
});
