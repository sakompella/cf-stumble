import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseJsonRecord } from "./cdp.mjs";
import { resolveChromePath } from "./chrome-binary.mjs";

/**
 * Starting a browser process, separate from driving it.
 *
 * Every flag here removes something that would make a local run non-deterministic or slow: a first
 * run dialog, an extension, a background update check, a default-browser prompt. The profile is a
 * fresh temporary directory, so one run never inherits another run's storage, and headless mode is
 * the new one because the old one is a different browser with different layout behaviour.
 */
const LAUNCH_ARGS = [
  "--headless=new",
  "--remote-debugging-port=0",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-extensions",
  "--disable-component-update",
  "--disable-background-networking",
  "--disable-dev-shm-usage",
  "--hide-scrollbars",
  "--mute-audio",
  "about:blank",
] as const;

/**
 * A browser process and its profile directory. {@link stopChromeProcess} is the only way either
 * goes away, so every path that started one must end in a call to it.
 */
export type ChromeProcess = Readonly<{
  process: ChildProcess;
  userDataDir: string;
  executable: string;
}>;

/**
 * The DevTools endpoint Chrome chose.
 *
 * The harness asks for port 0 so two runs can never collide on a fixed port, which means Chrome
 * picks the port and writes it to `DevToolsActivePort` in the profile directory. The HTTP endpoint
 * at that port then names the browser-level WebSocket. The signal ends the wait when Chrome exits
 * or the launch deadline passes.
 */
export async function readDebuggerUrl(userDataDir: string, signal: AbortSignal): Promise<string> {
  const portFile = join(userDataDir, "DevToolsActivePort");

  for (;;) {
    signal.throwIfAborted();
    const lines = (await readFile(portFile, "utf8").catch(() => "")).split("\n");
    const port = lines[0];

    if (lines.length > 1 && port !== undefined && port.length > 0) {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal });
      const url = parseJsonRecord(await response.text())?.text("webSocketDebuggerUrl");

      if (url !== undefined) {
        return url;
      }
    }

    await sleep(50);
  }
}

/**
 * Start Chrome in its own process group, so one signal reaches the renderer and GPU processes it
 * forks as well as the browser itself.
 */
export async function startChromeProcess(): Promise<ChromeProcess> {
  const executable = await resolveChromePath();
  const userDataDir = await mkdtemp(join(tmpdir(), "cf-stumble-harness-"));

  const chromeProcess = spawn(executable, [...LAUNCH_ARGS, `--user-data-dir=${userDataDir}`], {
    stdio: "ignore",
    detached: true,
  });

  return { process: chromeProcess, userDataDir, executable };
}

export type LaunchDeadline = Readonly<{ signal: AbortSignal; clear: () => void }>;

/**
 * Aborts when Chrome exits or fails to start, or when `timeoutMs` passes, with the reason as the
 * error. A caller waiting on Chrome then fails at once instead of waiting out the deadline.
 */
export function launchDeadline(chromeProcess: ChildProcess, timeoutMs: number): LaunchDeadline {
  const aborted = new AbortController();

  const timer = setTimeout(() => {
    aborted.abort(new Error(`Chrome was not attached within ${timeoutMs}ms`));
  }, timeoutMs);

  chromeProcess.once("exit", (code, signal) => {
    aborted.abort(new Error(`Chrome exited (${code ?? signal}) before the harness attached`));
  });
  chromeProcess.once("error", (error) => {
    aborted.abort(error);
  });

  return {
    signal: aborted.signal,
    clear: () => {
      clearTimeout(timer);
    },
  };
}

/**
 * Kill the browser's whole process group, wait for the browser to exit, and remove the profile.
 * A killed Chrome keeps writing its profile until its last child is gone, so removing the
 * directory before the process has exited fails with ENOTEMPTY. Safe to call when Chrome already
 * exited or never started.
 */
export async function stopChromeProcess(chrome: ChromeProcess): Promise<void> {
  const { process: chromeProcess, userDataDir } = chrome;

  if (chromeProcess.pid !== undefined) {
    try {
      process.kill(-chromeProcess.pid, "SIGKILL");
    } catch {
      // The group is already gone, which is what this call is for.
    }
  }

  const running =
    chromeProcess.pid !== undefined &&
    chromeProcess.exitCode === null &&
    chromeProcess.signalCode === null;

  if (running) {
    await once(chromeProcess, "exit");
  }

  await rm(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
