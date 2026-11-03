import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, relative } from "node:path";
import puppeteer from "puppeteer-core";
import { findOnPath, resolveExecutable } from "./chrome.ts";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "mdpx-chrome-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("resolveExecutable", () => {
  const env = { PATH: process.env.PATH, override: process.env.PUPPETEER_EXECUTABLE_PATH };

  beforeEach(() => {
    delete process.env.PUPPETEER_EXECUTABLE_PATH;
    process.env.PATH = root;
  });

  afterEach(() => {
    mock.restore();
    process.env.PATH = env.PATH;
    if (env.override) process.env.PUPPETEER_EXECUTABLE_PATH = env.override;
  });

  test("uses the Chrome puppeteer names when it is installed", async () => {
    const chrome = join(root, "Google Chrome");
    await writeFile(chrome, "", { mode: 0o755 });
    spyOn(puppeteer, "executablePath").mockResolvedValue(chrome);

    expect(await resolveExecutable()).toBe(chrome);
  });

  test("searches PATH when puppeteer names a Chrome that is not installed", async () => {
    await writeFile(join(root, "chromium"), "", { mode: 0o755 });
    spyOn(puppeteer, "executablePath").mockResolvedValue(join(root, "Google Chrome"));

    expect(await resolveExecutable()).toBe(join(root, "chromium"));
  });

  test("searches PATH when puppeteer has no Chrome for this platform", async () => {
    await writeFile(join(root, "chromium"), "", { mode: 0o755 });
    spyOn(puppeteer, "executablePath").mockRejectedValue(new Error("unsupported platform"));

    expect(await resolveExecutable()).toBe(join(root, "chromium"));
  });

  test("finds nothing when neither exists", async () => {
    spyOn(puppeteer, "executablePath").mockResolvedValue(join(root, "Google Chrome"));

    expect(await resolveExecutable()).toBeNull();
  });
});

describe("findOnPath", () => {
  test("skips relative entries, directories and non-executables, preferring earlier names over PATH order", async () => {
    const [local, first, second] = [join(root, "local"), join(root, "first"), join(root, "second")];
    await mkdir(local);
    await writeFile(join(local, "google-chrome"), "", { mode: 0o755 });
    await mkdir(join(first, "google-chrome"), { recursive: true });
    await writeFile(join(first, "chromium"), "", { mode: 0o644 });
    await writeFile(join(first, "chromium-browser"), "", { mode: 0o755 });
    await mkdir(second);
    await writeFile(join(second, "chromium"), "", { mode: 0o755 });
    const path = [relative(process.cwd(), local), first, second].join(delimiter);

    expect(findOnPath(["google-chrome", "chromium", "chromium-browser"], path)).toBe(join(second, "chromium"));
    expect(findOnPath(["google-chrome"], path)).toBeNull();
  });

  test("skips Snap launchers but not other wrapper scripts", async () => {
    const dir = root;
    await writeFile(join(dir, "snap"), "", { mode: 0o755 });
    await symlink(join(dir, "snap"), join(dir, "chromium"));
    await writeFile(join(dir, "chromium-browser"), '#!/bin/sh\nexec /snap/bin/chromium "$@"\n', { mode: 0o755 });
    await writeFile(join(dir, "google-chrome"), '#!/bin/sh\nexec /usr/lib/chromium/chromium "$@"\n', { mode: 0o755 });

    expect(findOnPath(["chromium", "chromium-browser", "google-chrome"], dir)).toBe(join(dir, "google-chrome"));
  });
});
