// Control of the resident Chrome (§4.3). The browser and page are reused for the whole process
// lifetime, and a reload is just a goto of the temporary HTML. Resolve executablePath → wait for the
// render to settle → screenshot tiles.

import { accessSync, constants, statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import puppeteer, { TimeoutError, type Browser, type Page } from "puppeteer-core";
import type { Anchor } from "./linemap.ts";
import type { Clip } from "./scheduler.ts";
import { CSS_SCALE } from "./viewport.ts";

/** A render failure caused by the page content (not a Chrome fault). The caller keeps the current frame. */
export class ContentError extends Error {}

/** Cap on domcontentloaded. Cuts off a parse that never returns (an infinite-loop script, say). */
const NAV_TIMEOUT_MS = 15000;

// Non-standard installs stay available through PUPPETEER_EXECUTABLE_PATH instead of being duplicated here.
const APP_PATHS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
];

// accessSync alone also accepts directories, which cannot be spawned as Chromium.
function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function parseExecutableEnv(raw: string | undefined): string | null {
  return raw && isExecutableFile(raw) ? raw : null;
}

export function resolveExecutable(): string | null {
  return (
    parseExecutableEnv(process.env.PUPPETEER_EXECUTABLE_PATH) ??
    APP_PATHS.find(isExecutableFile) ??
    null
  );
}

const STABLE_IMG_DECODE_MS = 1000;
const STABLE_MERMAID_MS = 3000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class Chrome {
  private browser: Browser | null = null;
  private page: Page | null = null;

  async launch(): Promise<void> {
    const executablePath = resolveExecutable();
    if (!executablePath) throw new Error("no Chromium found");
    // --hide-scrollbars and --force-color-profile=srgb are already in
    // puppeteer.defaultArgs({ headless: true }) and ignoreDefaultArgs is not set, so they are not
    // repeated. --allow-file-access-from-files is deliberately absent: it would let JS in raw HTML
    // inside the md read arbitrary local files over XHR (measured). Loading CSS/JS/font subresources
    // over file:// has been confirmed to work without the flag.
    this.browser = await puppeteer.launch({
      executablePath,
      headless: true,
      // Speak CDP over a stdio pipe. The default (pipe=false) adds --remote-debugging-port=0 and
      // leaves an unauthenticated CDP listening on 127.0.0.1 (for the whole session, since Chrome is
      // resident). Any process on the host could then read the ws URL from /json/version and read file://.
      pipe: true,
      // Signal handling is funnelled through main's shutdown. puppeteer's own handlers call a
      // synchronous process.exit(130) on SIGINT, which never reaches the tmpdir cleanup, and on
      // SIGHUP they only close the browser without ending our process (orphaning it).
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
    });
    this.page = await this.browser.newPage();
  }

  /**
   * Open the temporary HTML, wait for the render to settle, and return the full document height
   * (physical px) — §4.3. The viewport is set here every time, so it survives a restart that loses
   * the page state and does not depend on the caller's ordering.
   */
  async load(htmlPath: string, cssWidth: number, renderScale: number): Promise<number> {
    const page = this.page!;
    await page.setViewport({ width: cssWidth, height: 900, deviceScaleFactor: renderScale });
    try {
      await page.goto(pathToFileURL(htmlPath).href, {
        waitUntil: "domcontentloaded",
        timeout: NAV_TIMEOUT_MS,
      });
    } catch (e) {
      // Only a domcontentloaded timeout is content-caused (e.g. <script>for(;;)</script> blocking the
      // parse forever). Unlike a Chrome fault it fails identically after a restart, so it becomes a
      // ContentError. Anything else (a renderer/target crash, a dropped connection, a detached frame)
      // is a Page/Chrome fault and is rethrown for the caller to restart. Connection state cannot be
      // used to classify this, because Browser.connected can stay true while the Page is broken
      // (which would keep reusing a broken Page as if it were a ContentError).
      if (e instanceof TimeoutError) {
        throw new ContentError(`load timed out: ${e.message}`);
      }
      throw e;
    }
    await page.evaluate(() => document.fonts.ready);
    // Image decode (1s cap; images that miss it are captured missing)
    await Promise.race([
      page.evaluate(() =>
        Promise.all(Array.from(document.images).map((img) => img.decode().catch(() => {}))).then(
          () => {},
        ),
      ),
      sleep(STABLE_IMG_DECODE_MS),
    ]);
    // mermaid rendering (3s cap; a per-diagram error stays inside its own box)
    await page
      .waitForFunction("window.__mermaidDone === true", { timeout: STABLE_MERMAID_MS })
      .catch(() => {});
    const cssHeight = await page.evaluate(() =>
      Math.max(document.body.scrollHeight, document.documentElement.scrollHeight),
    );
    return cssHeight * CSS_SCALE;
  }

  /**
   * Return the {source line, CSS px} of every [data-source-line] element html.ts emitted, in document
   * order (§4.9). Assumes the page is loaded and finishes in a single evaluate (no measurable impact
   * on the ~1s save requirement).
   */
  collectAnchors(): Promise<Anchor[]> {
    return this.page!.evaluate(() =>
      Array.from(document.querySelectorAll("[data-source-line]"), (el) => ({
        line: Number(el.getAttribute("data-source-line")),
        // scrollY is 0 right after loading, but convert to document coordinates anyway so a future
        // change that scrolls the page does not break this silently
        top: el.getBoundingClientRect().top + window.scrollY,
      })).filter((a) => Number.isFinite(a.line)),
    );
  }

  async shoot(clip: Clip): Promise<string> {
    const data = await this.page!.screenshot({
      clip: { x: clip.x, y: clip.y, width: clip.width, height: clip.height },
      captureBeyondViewport: true,
      optimizeForSpeed: true,
      type: "png",
      encoding: "base64",
    });
    return data as string;
  }

  /** Evaluate a function in the loaded page. The hook the integration tests (§7) use to inspect the DOM; unused in production. */
  evaluate<T>(fn: () => T): Promise<T> {
    return this.page!.evaluate(fn);
  }

  async restart(): Promise<void> {
    await this.close();
    await this.launch();
  }

  async close(): Promise<void> {
    try {
      await this.browser?.close();
    } catch {
      // Even mid-crash, nothing here may block the terminal restore
    }
    this.browser = null;
    this.page = null;
  }
}
