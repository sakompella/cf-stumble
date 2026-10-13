import { ToolError } from "./error.mjs";
import { spawn, type ChildProcess } from "node:child_process";
import { cp, lstat, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { bidiListeningUrl, isSessionFile, isSessionStorage } from "./options.mjs";

export async function copyProfile(source: string, target: string): Promise<void> {
  const entries = await readdir(source);

  for (const name of entries) {
    if (isSessionFile(name)) {
      await cp(join(source, name), join(target, name), {
        filter: async (path) => !(await lstat(path)).isSymbolicLink(),
      });
    }
  }

  const storage = join(source, "storage/default");
  const origins = await readdir(storage).catch(() => []);

  for (const name of origins) {
    if (isSessionStorage(name)) {
      await cp(join(storage, name), join(target, "storage/default", name), {
        recursive: true,
        filter: async (path) => !(await lstat(path)).isSymbolicLink(),
      });
    }
  }

  await writeFile(
    join(target, "user.js"),
    [
      'user_pref("browser.shell.checkDefaultBrowser", false);',
      'user_pref("browser.startup.page", 0);',
      'user_pref("browser.startup.homepage_override.mstone", "ignore");',
      'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
      'user_pref("toolkit.telemetry.enabled", false);',
      'user_pref("app.update.auto", false);',
    ].join("\n"),
  );
}

type FirefoxProcess = Readonly<{ process: ChildProcess; endpoint: Promise<string> }>;

export function startFirefox(
  binary: string,
  profile: string,
  signal: AbortSignal,
  headed: boolean,
): FirefoxProcess {
  const child = spawn(
    binary,
    [
      ...(headed ? [] : ["--headless"]),
      "--no-remote",
      "--profile",
      profile,
      "--remote-debugging-port",
      "0",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );

  const endpoint = new Promise<string>((resolve, reject) => {
    let buffer = "";

    const timer = setTimeout(() => {
      reject(new ToolError("Firefox did not publish a BiDi endpoint"));
    }, 30_000);

    const abort = (): void => {
      reject(new ToolError("Interrupted"));
    };

    const settle = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    };

    signal.addEventListener("abort", abort, { once: true });
    child.once("error", () => {
      settle();
      reject(new ToolError("Could not launch Firefox"));
    });
    child.once("exit", () => {
      settle();
      reject(new ToolError("Firefox exited"));
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      buffer = (buffer + chunk.toString()).slice(-8192);
      const url = bidiListeningUrl(buffer);

      if (url !== undefined) {
        settle();
        resolve(url);
      }
    });
  });

  return { process: child, endpoint };
}

export async function stopFirefox(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, 3000);

    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}
