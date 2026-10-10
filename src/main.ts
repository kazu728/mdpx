#!/usr/bin/env node
import { errorExit, resolveCliMdPath, runApp } from "./run.ts";

const mdPath = resolveCliMdPath(process.argv.slice(2));
runApp(mdPath).catch(errorExit);
