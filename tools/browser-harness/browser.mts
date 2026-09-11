import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { rm } from "node:fs/promises";
import { CdpConnection } from "./cdp.mjs";
import { launchChromeProcess } from "./chrome-launch.mjs";
import { BrowserPage } from "./chrome.mjs";

/**
 * The browser process, and the tabs the runner opens in it.
 *
 * One Chrome serves every case: launching a browser costs about a second, and forty of those would
 * make this harness too slow to run. Isolation comes from the tab instead — each case gets a fresh
 * target with its own document, its own storage, and its own fault log — so nothing a case leaves
 * behind can reach the next one.
 */
export class HarnessChrome {
  private readonly process: ChildProcess;
  private readonly connection: CdpConnection;
  private readonly userDataDir: string;
  /** The binary this browser is running, so a report can say which browser produced it. */
  readonly executable: string;

  private constructor(
    chromeProcess: ChildProcess,
    connection: CdpConnection,
    userDataDir: string,
    executable: string,
  ) {
    this.process = chromeProcess;
    this.connection = connection;
    this.userDataDir = userDataDir;
    this.executable = executable;
  }

  static async launch(): Promise<HarnessChrome> {
    const chrome = await launchChromeProcess();
    const connection = await CdpConnection.open(chrome.debuggerUrl);

    return new HarnessChrome(chrome.process, connection, chrome.userDataDir, chrome.executable);
  }

  async openPage(): Promise<BrowserPage> {
    const target = await this.connection.send("Target.createTarget", { url: "about:blank" });
    const targetId = target.text("targetId");

    if (targetId === undefined) {
      throw new Error(`Chrome did not return a target id: ${target.json()}`);
    }

    const attached = await this.connection.send("Target.attachToTarget", {
      targetId,
      flatten: true,
    });

    const sessionId = attached.text("sessionId");

    if (sessionId === undefined) {
      throw new Error(`Chrome did not return a session id: ${attached.json()}`);
    }

    return BrowserPage.attach(this.connection, sessionId, targetId);
  }

  /**
   * A killed Chrome keeps writing its profile until its last child is gone, so removing the
   * directory before the process has exited fails with ENOTEMPTY and takes the whole run with it.
   */
  async close(): Promise<void> {
    this.connection.close();
    this.process.kill("SIGKILL");

    if (this.process.exitCode === null && this.process.signalCode === null) {
      await once(this.process, "exit");
    }

    await rm(this.userDataDir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }
}
