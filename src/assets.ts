// Absolute path resolution for the CSS / JS assets inside node_modules (for §4.2's file:// references).
// Path resolution is I/O, so it is confined here and handed to html.ts as resolved paths, keeping
// html.ts pure.

import { createRequire } from "node:module";
import type { Theme } from "./theme.ts";

// Absolute paths of in-package assets. All three subpaths resolve through exports
// (github-markdown-css has no exports restriction; katex and mermaid publish the relevant dist), so
// createRequire().resolve()'s standard resolution suffices. Walking up from import.meta.url covers
// both a local install and bun's global flat hoist (`~/.bun/install/global/node_modules`).
const require = createRequire(import.meta.url);

export interface Assets {
  /** Absolute fs path of github-markdown-css (per theme). */
  githubMarkdownCss: string;
  /** Absolute fs path of katex.min.css (referenced via link so its fonts resolve by relative url). */
  katexCss: string;
  /** Absolute fs path of the mermaid UMD bundle (loaded over file:// as a classic script). */
  mermaidJs: string;
}

export function resolveAssets(theme: Theme): Assets {
  return {
    githubMarkdownCss: require.resolve(`github-markdown-css/github-markdown-${theme}.css`),
    katexCss: require.resolve("katex/dist/katex.min.css"),
    mermaidJs: require.resolve("mermaid/dist/mermaid.min.js"),
  };
}
