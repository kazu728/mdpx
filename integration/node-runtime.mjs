import { renderDocument } from "../dist/markdown.js";

const MARKDOWN = "# h\n\n$x^2$\n\n- [ ] a\n\n```ts\nlet x = 1;\n```\n";
const EXPECTED = ['class="katex', "task-list-item", "shiki"];

const doc = await renderDocument(MARKDOWN, { theme: "dark", mdDir: import.meta.dirname });
const html = doc.blocks.map((b) => b.html).join("");

const missing = EXPECTED.filter((needle) => !html.includes(needle));
if (missing.length > 0 || doc.blocks.length !== 4) {
  console.error(`node-runtime: missing from the rendered HTML: ${missing.join(", ")} (${doc.blocks.length} blocks)`);
  process.exit(1);
}
console.log("node-runtime: ok");
