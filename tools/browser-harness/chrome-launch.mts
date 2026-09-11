import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
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

export type ChromeProcess = Readonly<{
  process: ChildProcess;
  debuggerUrl: string;
  userDataDir: string;
  executable: string;
}>;

/**
 * The DevTools endpoint Chrome chose.
 *
 * The harness asks for port 0 so two runs can never collide on a fixed port, which means Chrome
 * picks the port and writes it to `DevToolsActivePort` in the profile directory. The HTTP endpoint
 * at that port then names the browser-level WebSocket.
 */
async function readDebuggerUrl(userDataDir: string, deadline: number): Promise<string> {
  const portFile = join(userDataDir, "DevToolsActivePort");

  while (Date.now() < deadline) {
    const lines = (await readFile(portFile, "utf8").catch(() => "")).split("\n");
    const port = lines[0];

    if (lines.length > 1 && port !== undefined && port.length > 0) {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      const url = parseJsonRecord(await response.text())?.text("webSocketDebuggerUrl");

      if (url !== undefined) {
        return url;
      }
    }

    await sleep(50);
  }

  throw new Error("Chrome did not publish a DevTools port within the launch timeout");
}

export async function launchChromeProcess(): Promise<ChromeProcess> {
  const executable = await resolveChromePath();
  const userDataDir = await mkdtemp(join(tmpdir(), "cf-stumble-harness-"));

  const chromeProcess = spawn(executable, [...LAUNCH_ARGS, `--user-data-dir=${userDataDir}`], {
    stdio: "ignore",
  });

  const debuggerUrl = await readDebuggerUrl(userDataDir, Date.now() + 30_000);

  return { process: chromeProcess, debuggerUrl, userDataDir, executable };
}
