import { describe, expect, test } from "bun:test";
import markdownit from "markdown-it";
import { githubAlerts } from "./alerts.ts";

const render = (markdown: string) => markdownit({ html: true }).use(githubAlerts).render(markdown + "\n");

describe("githubAlerts follows GitHub's output", () => {
  test.each([
    "> [!NOTE]\n> x",
    "> [!note]\n> x",
    "> \\[!NOTE]\n> x",
    ">[!NOTE]\n> x",
    "> [!NOTE]   \n> x",
    "> [!NOTE]\n>\n> x",
    "> [!NOTE]\n> - x",
    "> [!NOTE]\nx",
    "<section>\n\n> [!NOTE]\n> x\n\n</section>",
    "<table><tr><td>\n\n> [!NOTE]\n> x\n\n</td></tr></table>",
    '<a href="x">\n\n> [!NOTE]\n> x\n\n</a>',
    "<span>\n\n> [!NOTE]\n> x\n\n</span>",
    "<p>lead\n\n> [!NOTE]\n> x",
    "<div>x</div>\n\n> [!NOTE]\n> x",
    "<details><summary>s</summary>x</details>\n\n> [!NOTE]\n> x",
    "</div>\n\n> [!NOTE]\n> x",
    "<!-- <div> -->\n\n> [!NOTE]\n> x",
    "a <picture>\n\n> [!NOTE]\n> x\n\n</picture>",
    "a <div>x</div>\n\n> [!NOTE]\n> x",
    "a <div>\n\nb </div>\n\n> [!NOTE]\n> x",
    "<div>\n\nb </div>\n\n> [!NOTE]\n> x",
    "a <span>\n\n> [!NOTE]\n> x",
    "a `<div>` code\n\n> [!NOTE]\n> x",
    "a \\<div>\n\n> [!NOTE]\n> x",
    "a <!-- <div> -->\n\n> [!NOTE]\n> x",
    "> a <div>\n\n> [!NOTE]\n> x",
    "# a <div>\n\n> [!NOTE]\n> x",
    "- a <div>\n\n> [!NOTE]\n> x",
    "| a <div> |\n|---|\n\n> [!NOTE]\n> x",
  ])("%j is an alert", (markdown) => {
    const html = render(markdown);
    expect(html).toContain('<div class="markdown-alert markdown-alert-note">');
    expect(html).not.toContain("[!");
    expect(html).not.toContain("<p></p>");
  });

  test.each([
    "> [!NOTE] title\n> x",
    "> [!NOTE]x\n> y",
    "> [!TIP]",
    "> [!NOTE]\n>",
    "> [!UNKNOWN]\n> x",
    "> [!constructor]\n> x",
    "> lead\n> [!NOTE]\n> x",
    "> **[!NOTE]**\n> x",
    "- a\n  > [!NOTE]\n  > x",
    "> > [!NOTE]\n> > x",
    "> # [!NOTE]\n> x",
    ">",
    "<div>\n\n> [!NOTE]\n> x\n\n</div>",
    "</div>\n\n<div>\n\n> [!NOTE]\n> x\n\n</div>",
    "<details>\n\n> [!NOTE]\n> x\n\n</details>",
    "<blockquote>\n\n> [!NOTE]\n> x\n\n</blockquote>",
    "<li>\n\n> [!NOTE]\n> x",
    "<picture>\n\n> [!NOTE]\n> x\n\n</picture>",
    "a <div>\n\n> [!NOTE]\n> x\n\n</div>",
    "a <DIV>\n\n> [!NOTE]\n> x",
    "a <details>\n\n> [!NOTE]\n> x\n\n</details>",
    "a <blockquote>\n\n> [!NOTE]\n> x\n\n</blockquote>",
    "a <li>\n\n> [!NOTE]\n> x",
    "**a <div>**\n\n> [!NOTE]\n> x",
    "[a <div>](x)\n\n> [!NOTE]\n> x",
  ])("%j stays a blockquote", (markdown) => {
    const html = render(markdown);
    expect(html).toContain("<blockquote>");
    expect(html).not.toContain("markdown-alert");
  });

  test("the text after the marker is parsed as usual", () => {
    expect(render("> [!NOTE]\n> **bold**")).toContain("<p><strong>bold</strong></p>");
  });

  test("an alert closes around a blockquote nested in it", () => {
    const html = render("> [!WARNING]\n> body\n>\n> > nested\n>\n> after").replace(/<svg.*<\/svg>/, "").replace(/\n/g, "");
    expect(html).toBe(
      '<div class="markdown-alert markdown-alert-warning"><p class="markdown-alert-title">Warning</p>' +
        "<p>body</p><blockquote><p>nested</p></blockquote><p>after</p></div>",
    );
  });
});
