import { createRequire } from "node:module";
import type { Theme } from "./theme.ts";

const require = createRequire(import.meta.url);

export interface Assets {
  githubMarkdownCss: string;
  katexCss: string;
  mermaidJs: string;
}

export function resolveAssets(theme: Theme): Assets {
  return {
    githubMarkdownCss: require.resolve(`github-markdown-css/github-markdown-${theme}.css`),
    katexCss: require.resolve("katex/dist/katex.min.css"),
    mermaidJs: require.resolve("mermaid/dist/mermaid.min.js"),
  };
}
