import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderDocument, type Theme } from "./markdown.ts";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "mdpx-md-"));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

const render = (markdown: string, theme: Theme = "light") => renderDocument(markdown, { theme, mdDir: dir });
const keys = async (markdown: string, theme: Theme = "light") => (await render(markdown, theme)).blocks.map((b) => b.key);

describe("renderDocument", () => {
  test("splits the document into top-level blocks, with headings marked", async () => {
    const doc = await render("# Title\n\nSome *text*.\n\n- a\n- b\n\n```ts\nlet x = 1;\n```\n\n| a |\n|---|\n| 1 |\n");
    expect(doc.blocks.map((b) => b.kind)).toEqual(["heading", "other", "other", "other", "other"]);
    expect(doc.blocks[1]!.html).toBe("<p>Some <em>text</em>.</p>\n");
    expect(doc.blocks[2]!.html).toContain("<ul>");
  });

  test("keys are stable across renders and change only for the edited block", async () => {
    const a = await keys("# T\n\nfirst\n\nsecond\n");
    expect(await keys("# T\n\nfirst\n\nsecond\n")).toEqual(a);
    const b = await keys("# T\n\nfirst, edited\n\nsecond\n");
    expect(b[0]).toBe(a[0]);
    expect(b[1]).not.toBe(a[1]);
    expect(b[2]).toBe(a[2]);
    // Re-wrapping the source without changing the rendering keeps the key.
    expect((await keys("# T\n\nfirst\n\n\n\nsecond\n"))[2]).toBe(a[2]);
  });

  test("the theme is part of every key", async () => {
    const light = await keys("plain\n\n```ts\nlet x = 1;\n```\n");
    const dark = await keys("plain\n\n```ts\nlet x = 1;\n```\n", "dark");
    expect(dark.every((k, i) => k !== light[i])).toBe(true);
    const code = (await render("```ts\nlet x = 1;\n```\n", "dark")).blocks[0]!.html;
    expect(code).toContain('class="shiki github-dark');
    expect(code.slice(0, code.indexOf(">"))).not.toContain("background-color");
  });

  test("changing a reference definition re-keys the paragraph that uses it", async () => {
    const a = await keys("see [docs][d]\n\nother\n\n[d]: https://a.example\n");
    const b = await keys("see [docs][d]\n\nother\n\n[d]: https://b.example\n");
    expect(b[0]).not.toBe(a[0]);
    expect(b[1]).toBe(a[1]);
  });

  test("raw HTML left open is grouped with the blocks until it closes", async () => {
    const doc = await render("<details>\n<summary>more</summary>\n\ninside **bold**\n\n</details>\n\nafter\n");
    expect(doc.blocks).toHaveLength(2);
    expect(doc.blocks[0]!.html).toMatch(/^<details>[\s\S]*<strong>bold<\/strong>[\s\S]*<\/details>\n$/);
    expect(doc.blocks[1]!.html).toBe("<p>after</p>\n");
  });

  test("overwriting a local image re-keys the block that shows it", async () => {
    const png = join(dir, "pic.png");
    await writeFile(png, "one");
    const md = "![pic](./pic.png)\n\ntext\n";
    const a = await keys(md);
    await writeFile(png, "two!");
    await utimes(png, new Date(), new Date(Date.now() + 5000));
    const b = await keys(md);
    expect(b[0]).not.toBe(a[0]);
    expect(b[1]).toBe(a[1]);
  });

  test("Mermaid fences become escaped diagram sources; math renders with KaTeX", async () => {
    const doc = await render("```mermaid\ngraph TD; A-->B\n```\n\n$E = mc^2$\n");
    expect(doc.blocks[0]!.html).toBe('<pre class="mermaid">graph TD; A--&gt;B\n</pre>\n');
    expect(doc.blocks[1]!.html).toMatch(/class="katex/);
  });

  test("meta tags in the body cannot redirect the page", async () => {
    const doc = await render(
      '<meta http-equiv="refresh" content="0;url=https://example.com">\n\n' +
        '<<meta>meta http-equiv="refresh" content="0;url=https://example.com">\n',
    );
    const html = doc.blocks.map((b) => b.html).join("");
    expect(html).not.toMatch(/<meta\b/i);
    expect(html).toContain('&lt;meta http-equiv="refresh"');
  });
});
