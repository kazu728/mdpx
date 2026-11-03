import type { MarkdownIt, Token } from "markdown-it";

const ALERTS = new Map([
  ["note", { title: "Note", path: "M0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8Zm8-6.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM6.5 7.75A.75.75 0 0 1 7.25 7h1a.75.75 0 0 1 .75.75v2.75h.25a.75.75 0 0 1 0 1.5h-2a.75.75 0 0 1 0-1.5h.25v-2h-.25a.75.75 0 0 1-.75-.75ZM8 6a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z" }],
  ["tip", { title: "Tip", path: "M8 1.5c-2.363 0-4 1.69-4 3.75 0 .984.424 1.625.984 2.304l.214.253c.223.264.47.556.673.848.284.411.537.896.621 1.49a.75.75 0 0 1-1.484.211c-.04-.282-.163-.547-.37-.847a8.456 8.456 0 0 0-.542-.68c-.084-.1-.173-.205-.268-.32C3.201 7.75 2.5 6.766 2.5 5.25 2.5 2.31 4.863 0 8 0s5.5 2.31 5.5 5.25c0 1.516-.701 2.5-1.328 3.259-.095.115-.184.22-.268.319-.207.245-.383.453-.541.681-.208.3-.33.565-.37.847a.751.751 0 0 1-1.485-.212c.084-.593.337-1.078.621-1.489.203-.292.45-.584.673-.848.075-.088.147-.173.213-.253.561-.679.985-1.32.985-2.304 0-2.06-1.637-3.75-4-3.75ZM5.75 12h4.5a.75.75 0 0 1 0 1.5h-4.5a.75.75 0 0 1 0-1.5ZM6 15.25a.75.75 0 0 1 .75-.75h2.5a.75.75 0 0 1 0 1.5h-2.5a.75.75 0 0 1-.75-.75Z" }],
  ["important", { title: "Important", path: "M0 1.75C0 .784.784 0 1.75 0h12.5C15.216 0 16 .784 16 1.75v9.5A1.75 1.75 0 0 1 14.25 13H8.06l-2.573 2.573A1.458 1.458 0 0 1 3 14.543V13H1.75A1.75 1.75 0 0 1 0 11.25Zm1.75-.25a.25.25 0 0 0-.25.25v9.5c0 .138.112.25.25.25h2a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h6.5a.25.25 0 0 0 .25-.25v-9.5a.25.25 0 0 0-.25-.25Zm7 2.25v2.5a.75.75 0 0 1-1.5 0v-2.5a.75.75 0 0 1 1.5 0ZM9 9a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z" }],
  ["warning", { title: "Warning", path: "M6.457 1.047c.659-1.234 2.427-1.234 3.086 0l6.082 11.378A1.75 1.75 0 0 1 14.082 15H1.918a1.75 1.75 0 0 1-1.543-2.575Zm1.763.707a.25.25 0 0 0-.44 0L1.698 13.132a.25.25 0 0 0 .22.368h12.164a.25.25 0 0 0 .22-.368Zm.53 3.996v2.5a.75.75 0 0 1-1.5 0v-2.5a.75.75 0 0 1 1.5 0ZM9 11a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z" }],
  ["caution", { title: "Caution", path: "M4.47.22A.749.749 0 0 1 5 0h6c.199 0 .389.079.53.22l4.25 4.25c.141.14.22.331.22.53v6a.749.749 0 0 1-.22.53l-4.25 4.25A.749.749 0 0 1 11 16H5a.749.749 0 0 1-.53-.22L.22 11.53A.749.749 0 0 1 0 11V5c0-.199.079-.389.22-.53Zm.84 1.28L1.5 5.31v5.38l3.81 3.81h5.38l3.81-3.81V5.31L10.69 1.5ZM8 4a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0v-3.5A.75.75 0 0 1 8 4Zm0 8a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z" }],
]);

const MARKER = /^\\?\[!(\w+)\][ \t]*(?:\n|$)/;
const IN_HTML_BLOCK = /<(\/?)(?:blockquote|details|div|li|picture)(?=[\s/>])[^>]*>/gi;
const IN_PARAGRAPH = /<(\/?)(?:blockquote|details|div|li)(?=[\s/>])[^>]*>/gi;

function netOpened(html: string, tag: RegExp): number {
  let depth = 0;
  for (const [, closing] of html.replace(/<!--[\s\S]*?-->/g, "").matchAll(tag)) depth += closing ? -1 : 1;
  return depth;
}

function netOpenedBy(tokens: Token[], i: number): number {
  const token = tokens[i]!;
  if (token.type === "html_block") return netOpened(token.content, IN_HTML_BLOCK);
  if (token.type !== "paragraph_open") return 0;
  const inlineHtml = tokens[i + 1]!.children!.filter((t) => t.type === "html_inline").map((t) => t.content);
  return netOpened(inlineHtml.join(""), IN_PARAGRAPH);
}

export function githubAlerts(md: MarkdownIt): void {
  md.core.ruler.after("inline", "github_alerts", (state) => {
    const tokens = state.tokens;
    let blocking = 0;
    for (let i = 0; i < tokens.length; i++) {
      const open = tokens[i]!;
      if (open.level !== 0) continue;
      blocking = Math.max(0, blocking + netOpenedBy(tokens, i));
      if (open.type !== "blockquote_open" || blocking > 0 || tokens[i + 1]!.type !== "paragraph_open") continue;

      const inline = tokens[i + 2]!;
      const marker = MARKER.exec(inline.content);
      if (!marker) continue;
      const type = marker[1]!.toLowerCase();
      const alert = ALERTS.get(type);
      const body = inline.content.slice(marker[0].length);
      if (!alert || (!body && tokens[i + 4]!.type === "blockquote_close")) continue;

      open.tag = "div";
      open.attrSet("class", `markdown-alert markdown-alert-${type}`);
      tokens.slice(i).find((t) => t.type === "blockquote_close" && t.level === 0)!.tag = "div";

      const title = new state.Token("html_block", "", 0);
      title.level = 1;
      title.content = `<p class="markdown-alert-title"><svg class="octicon mr-2" viewBox="0 0 16 16" width="16" height="16"><path d="${alert.path}"/></svg>${alert.title}</p>`;
      if (body) {
        inline.content = body;
        inline.children = [];
        state.md.inline.parse(body, state.md, state.env, inline.children);
      }
      tokens.splice(i + 1, body ? 0 : 3, title);
    }
  });
}
