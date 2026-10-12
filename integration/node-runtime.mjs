// Resolving the modules is not enough: a CJS interop difference only breaks once a plugin is applied.
import { buildHtml, resolveAssets } from "../dist/html.js";

const MARKDOWN = "# h\n\n$x^2$\n\n- [ ] a\n\n```ts\nlet x = 1;\n```\n";
// The KaTeX stylesheet path contains "katex" on every page; only rendered math carries the class.
const EXPECTED = ['class="katex', "task-list-item", "shiki"];

const html = await buildHtml({
  markdown: MARKDOWN,
  mdDir: import.meta.dirname,
  assets: resolveAssets(),
  theme: "dark",
});

const missing = EXPECTED.filter((needle) => !html.includes(needle));
if (missing.length > 0) {
  console.error(`node-runtime: missing from the rendered HTML: ${missing.join(", ")}`);
  process.exit(1);
}
console.log("node-runtime: ok");
