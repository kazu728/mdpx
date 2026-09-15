import { pathToFileURL } from "node:url";
import puppeteer, { TimeoutError, type Browser, type Page } from "puppeteer-core";
import type { Anchor } from "./sourcemap.ts";
import type { Clip } from "./geometry.ts";

/** Content-caused failure (not a Chrome fault); the caller keeps the current frame. */
export class ContentError extends Error {}

/** Cap domcontentloaded; a parse that never returns is treated as content-caused. */
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

const STABLE_FONTS_MS = 500;
const STABLE_IMG_DECODE_MS = 1000;
const STABLE_MERMAID_MS = 3000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class Chrome {
  private browser: Browser | null = null;
  page: Page | null = null;

  constructor(private readonly executablePath: string | null) {}

  async launch(): Promise<void> {
    if (!this.executablePath) throw new Error("no Chromium found");
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
      if (e instanceof TimeoutError) {
        throw new ContentError(`load timed out: ${e.message}`);
      }
      throw e;
    }
    await Promise.race([page.evaluate(() => document.fonts.ready), sleep(STABLE_FONTS_MS)]);
    await Promise.race([this.decodeAllImages(), sleep(STABLE_IMG_DECODE_MS)]);
    await page
      .waitForFunction("window.__mermaidDone === true", { timeout: STABLE_MERMAID_MS })
      .catch(() => {});
    const documentHeightCssPx = await page.evaluate(() => document.body.scrollHeight);
    return documentHeightCssPx;
  }

  private decodeAllImages(): Promise<void> {
    return this.page!.evaluate(() =>
      Promise.all(Array.from(document.images).map((img) => img.decode().catch(() => {}))).then(
        () => {},
      ),
    );
  }

  collectAnchors(): Promise<Anchor[]> {
    return this.page!.evaluate(() =>
      Array.from(document.querySelectorAll("[data-source-line]"), (el) => ({
        sourceLine: Number(el.getAttribute("data-source-line")),
        topCssPx: el.getBoundingClientRect().top + window.scrollY,
      })),
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
      optimizeForSpeed: true,
      encoding: "base64",
    });
    return data as string;
  }

  async close(): Promise<void> {
    try {
      await this.browser?.close();
    } catch {}
    this.browser = null;
    this.page = null;
  }
}
