// Minimal declarations for plugins that ship no types.
declare module "markdown-it-task-lists" {
  import type MarkdownIt from "markdown-it";
  const plugin: MarkdownIt.PluginWithOptions<{ enabled?: boolean; label?: boolean }>;
  export default plugin;
}
