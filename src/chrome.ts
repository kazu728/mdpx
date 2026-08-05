import { pathToFileURL } from "node:url";
import puppeteer, { TimeoutError, type Browser, type Page } from "puppeteer-core";
import type { Anchor } from "./linemap.ts";
import type { Clip } from "./scheduler.ts";
import { CSS_SCALE } from "./viewport.ts";

/** A render failure caused by the page content (not a Chrome fault). The caller keeps the current frame. */
export class ContentError extends Error {}

/** Cap on domcontentloaded. Cuts off a parse that never returns (an infinite-loop script, say). */
const NAV_TIMEOUT_MS = 15000;

export async function resolveExecutable(): Promise<string | null> {
  const override = process.env.PUPPETEER_EXECUTABLE_PATH;
  if (override) return override;
  try {
    return await puppeteer.executablePath("chrome");
  } catch {
    return null;
  }
}

const STABLE_IMG_DECODE_MS = 1000;
const STABLE_MERMAID_MS = 3000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class Chrome {
  private browser: Browser | null = null;
  private page: Page | null = null;

  constructor(private readonly executablePath: string | null) {}

  async launch(): Promise<void> {
    if (!this.executablePath) throw new Error("no Chromium found");
    // Do not enable --allow-file-access-from-files: body scripts could then read local files over XHR.
    this.browser = await puppeteer.launch({
      executablePath: this.executablePath,
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

  async load(
    htmlPath: string,
    viewportWidthCssPx: number,
    renderScale: number,
  ): Promise<number> {
    const page = this.page!;
    await page.setViewport({
      width: viewportWidthCssPx,
      height: 900,
      deviceScaleFactor: renderScale,
    });
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
    await Promise.race([
      page.evaluate(() =>
        Promise.all(Array.from(document.images).map((img) => img.decode().catch(() => {}))).then(
          () => {},
        ),
      ),
      sleep(STABLE_IMG_DECODE_MS),
    ]);
    await page
      .waitForFunction("window.__mermaidDone === true", { timeout: STABLE_MERMAID_MS })
      .catch(() => {});
    const documentHeightCssPx = await page.evaluate(() =>
      Math.max(document.body.scrollHeight, document.documentElement.scrollHeight),
    );
    return documentHeightCssPx * CSS_SCALE;
  }

  collectAnchors(): Promise<Anchor[]> {
    return this.page!.evaluate(() =>
      Array.from(document.querySelectorAll("[data-source-line]"), (el) => ({
        sourceLine: Number(el.getAttribute("data-source-line")),
        topCssPx: el.getBoundingClientRect().top + window.scrollY,
      })).filter((anchor) => Number.isFinite(anchor.sourceLine)),
    );
  }

  async shoot(clip: Clip): Promise<string> {
    const data = await this.page!.screenshot({
      clip: {
        x: clip.xCssPx,
        y: clip.yCssPx,
        width: clip.widthCssPx,
        height: clip.heightCssPx,
      },
      captureBeyondViewport: true,
      optimizeForSpeed: true,
      type: "png",
      encoding: "base64",
    });
    return data as string;
  }

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
