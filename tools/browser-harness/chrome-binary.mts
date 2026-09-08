import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { readdir } from "node:fs/promises";

/**
 * Where the harness finds a real browser.
 *
 * The harness must not install one: adding a browser download to this repository's dependencies
 * would change the lockfile for a check that already has a Chrome available on every machine that
 * runs it. So the binary is discovered, in a stated order, and a machine without one is told
 * exactly what to set rather than being given a launch failure to interpret.
 *
 * The order is: an explicit `CF_STUMBLE_CHROME`, then the Playwright browser cache (which is where
 * an installed browser lives on a developer machine and in CI), then a system install. Inside the
 * cache the newest build wins, and a full browser is preferred over the headless shell because the
 * shell cannot report a viewport the way a full browser does.
 */
const CACHE_RELATIVE_PATHS = [
  "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  "chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  "chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium",
  "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
  "chrome-linux/chrome",
  "chrome-headless-shell-mac-arm64/chrome-headless-shell",
  "chrome-headless-shell-mac/chrome-headless-shell",
  "chrome-headless-shell-linux64/chrome-headless-shell",
] as const;

const SYSTEM_PATHS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
] as const;

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** The build number in a cache directory name, so `chromium-1234` sorts after `chromium-987`. */
function buildNumber(directoryName: string): number {
  return Math.trunc(Number(directoryName.replace(/^\D+/u, "")));
}

function isFullBrowser(directoryName: string): boolean {
  return !directoryName.startsWith("chromium_headless_shell");
}

async function playwrightCacheCandidates(): Promise<readonly string[]> {
  const cache = join(homedir(), "Library/Caches/ms-playwright");
  const linuxCache = join(homedir(), ".cache/ms-playwright");
  const roots = [cache, linuxCache];
  const candidates: string[] = [];

  for (const root of roots) {
    const entries = await readdir(root).catch(() => []);
    const browsers = entries
      .filter((entry) => entry.startsWith("chromium"))
      .toSorted((left, right) => {
        const byKind = Number(isFullBrowser(right)) - Number(isFullBrowser(left));
        return byKind === 0 ? buildNumber(right) - buildNumber(left) : byKind;
      });
    for (const browser of browsers) {
      for (const relative of CACHE_RELATIVE_PATHS) {
        candidates.push(join(root, browser, relative));
      }
    }
  }
  return candidates;
}

export async function resolveChromePath(): Promise<string> {
  const configured = process.env.CF_STUMBLE_CHROME;
  if (configured !== undefined && configured.length > 0) {
    if (await isExecutableFile(configured)) {
      return configured;
    }
    throw new Error(`CF_STUMBLE_CHROME is set to ${configured}, which is not a file`);
  }

  for (const candidate of [...(await playwrightCacheCandidates()), ...SYSTEM_PATHS]) {
    if (await isExecutableFile(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    "no Chrome or Chromium binary was found. Install one with `pnpm dlx playwright install chromium`, " +
      "or set CF_STUMBLE_CHROME to the full path of a Chrome, Chromium, or Edge executable.",
  );
}
