import { accessSync, closeSync, constants, openSync, readSync, realpathSync, statSync } from "node:fs";
import { basename, delimiter, isAbsolute, join } from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";

const PATH_EXECUTABLES = ["google-chrome-stable", "google-chrome", "chromium", "chromium-browser"];

export async function resolveExecutable(): Promise<string | null> {
  const override = process.env.PUPPETEER_EXECUTABLE_PATH;
  if (override) return override;
  try {
    return await puppeteer.executablePath("chrome");
  } catch {
    return findOnPath(PATH_EXECUTABLES, process.env.PATH ?? "");
  }
}

export function findOnPath(names: readonly string[], pathEnv: string): string | null {
  // Relative entries (and empty ones, which mean ".") would launch a binary from the cwd.
  const dirs = pathEnv.split(delimiter).filter(isAbsolute);
  for (const name of names) {
    for (const dir of dirs) {
      const candidate = join(dir, name);
      try {
        accessSync(candidate, constants.X_OK);
        if (statSync(candidate).isFile() && !isSnap(candidate)) return candidate;
      } catch {}
    }
  }
  return null;
}

const SCRIPT_HEAD_BYTES = 4096;

/** Snap gives Chromium a private /tmp, so it could not open the page mdpx writes there. */
function isSnap(executable: string): boolean {
  const real = realpathSync(executable);
  if (basename(real) === "snap") return true;
  const head = Buffer.alloc(SCRIPT_HEAD_BYTES);
  const fd = openSync(real, "r");
  let bytes: number;
  try {
    bytes = readSync(fd, head);
  } finally {
    closeSync(fd);
  }
  const text = head.toString("latin1", 0, bytes);
  return text.startsWith("#!") && text.includes("/snap/bin/");
}

export class Chrome {
  private browser: Browser | null = null;
  page: Page | null = null;

  constructor(private readonly executablePath: string) {}

  async launch(): Promise<void> {
    // No --allow-file-access-from-files: body scripts could read local files over XHR.
    this.browser = await puppeteer.launch({
      executablePath: this.executablePath,
      // pipe:true avoids an unauthenticated CDP port on 127.0.0.1 for the whole session.
      pipe: true,
      // Shutdown is funnelled through main; puppeteer handlers would exit(130) or orphan us.
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
    });
    this.page = (await this.browser.pages())[0] ?? (await this.browser.newPage());
  }

  async close(): Promise<void> {
    try {
      await this.browser?.close();
    } catch {}
    this.browser = null;
    this.page = null;
  }
}
