#!/usr/bin/env node
import { sanitizeTerminalBlock } from "./frame.ts";
import { resolveCliMdPath, runApp } from "./run.ts";

const mdPath = resolveCliMdPath(process.argv.slice(2), "mdpx");
runApp(mdPath).catch((e) => {
  process.stderr.write(sanitizeTerminalBlock(`mdpx: ${e?.stack ?? e}\n`));
  process.exit(1);
});
