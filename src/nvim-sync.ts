#!/usr/bin/env node
import { sanitizeTerminalBlock } from "./frame.ts";
import { resolveCliMdPath, runApp } from "./run.ts";
import { NvimCursor } from "./sync/nvim.ts";
import { ScrollTracker } from "./sync/tracker.ts";

const mdPath = resolveCliMdPath(process.argv.slice(2), "mdpx-nvim-sync");
const nvim = new NvimCursor(mdPath);
const tracker = new ScrollTracker();

runApp({
  mdPath,
  onShutdown: () => nvim.close(),
  onFrameMapped: (gen, meta) => tracker.setFrame(gen, meta),
  onFrameReleased: (gen) => tracker.releaseFrame(gen),
  onScroll: (info) => {
    const line = tracker.displayedSourceLine(info);
    if (line !== null) nvim.send(line);
  },
}).catch((e) => {
  process.stderr.write(sanitizeTerminalBlock(`mdpx: ${e?.stack ?? e}\n`));
  process.exit(1);
});
