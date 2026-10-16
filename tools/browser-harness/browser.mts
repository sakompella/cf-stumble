import { CdpConnection } from "./cdp.mjs";
import {
  launchDeadline,
  readDebuggerUrl,
  startChromeProcess,
  stopChromeProcess,
  type ChromeProcess,
} from "./chrome-launch.mjs";
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
  private readonly chrome: ChromeProcess;
  private readonly connection: CdpConnection;
  /** The binary this browser is running, so a report can say which browser produced it. */
  readonly executable: string;

  private constructor(chrome: ChromeProcess, connection: CdpConnection) {
    this.chrome = chrome;
    this.connection = connection;
    this.executable = chrome.executable;
  }

  /**
   * Start Chrome and attach to it. Whatever goes wrong before the attach completes (Chrome exits,
   * never publishes its port, or never answers the socket) stops the browser and removes its
   * profile before the error reaches the caller.
   */
  static async launch(launchTimeoutMs = 30_000): Promise<HarnessChrome> {
    const chrome = await startChromeProcess();
    const deadline = launchDeadline(chrome.process, launchTimeoutMs);

    try {
      const debuggerUrl = await readDebuggerUrl(chrome.userDataDir, deadline.signal);
      const connection = await CdpConnection.open(debuggerUrl, undefined, deadline.signal);

      return new HarnessChrome(chrome, connection);
    } catch (error) {
      await stopChromeProcess(chrome);
      throw error;
    } finally {
      deadline.clear();
    }
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

  async close(): Promise<void> {
    this.connection.close();
    await stopChromeProcess(this.chrome);
  }
}
