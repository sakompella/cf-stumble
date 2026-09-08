import { collectBrowserErrors } from "./browser-errors.mjs";
import type { CdpConnection, CdpResult } from "./cdp.mjs";
import type { JsonValue } from "./json.mjs";
import { setTimeout as sleep } from "node:timers/promises";

/**
 * One tab of a real Chrome, driven over the DevTools Protocol, with the smallest page surface this
 * harness needs.
 *
 * Every method corresponds to something an owner does with a mouse, a keyboard, or a window, and
 * nothing here simulates an event the browser would not itself produce. A click is a real mouse
 * press at the element's centre, so an element the layout has covered or collapsed fails the click
 * instead of quietly passing through a synthetic `dispatchEvent`.
 *
 * A tab is created by {@link HarnessChrome}, which owns the browser process. Faults are collected
 * per tab, so one case cannot inherit the console errors of the case before it.
 */

/** The keys the harness presses. The virtual key code matters: Chrome drops a key without one. */
const KEYS = {
  Tab: { code: "Tab", keyCode: 9, text: "" },
  Enter: { code: "Enter", keyCode: 13, text: "\r" },
  Escape: { code: "Escape", keyCode: 27, text: "" },
  Space: { code: "Space", keyCode: 32, text: " " },
  ArrowDown: { code: "ArrowDown", keyCode: 40, text: "" },
  ArrowUp: { code: "ArrowUp", keyCode: 38, text: "" },
} as const;

export type HarnessKey = keyof typeof KEYS;

/** The modifier bits DevTools defines. A page reads them as `event.ctrlKey` and friends. */
const MODIFIERS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 } as const;

export type HarnessModifier = keyof typeof MODIFIERS;

export type ElementBox = Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
  top: number;
  right: number;
  bottom: number;
  left: number;
}>;

function quoted(value: string): string {
  return JSON.stringify(value);
}

export class BrowserPage {
  private readonly connection: CdpConnection;
  readonly sessionId: string;
  private readonly targetId: string;
  private readonly errors: () => readonly string[];

  private constructor(connection: CdpConnection, sessionId: string, targetId: string) {
    this.connection = connection;
    this.sessionId = sessionId;
    this.targetId = targetId;
    this.errors = collectBrowserErrors(connection, sessionId);
  }

  /** Adopt an attached target. {@link HarnessChrome.openPage} is the only caller. */
  static async attach(
    connection: CdpConnection,
    sessionId: string,
    targetId: string,
  ): Promise<BrowserPage> {
    const page = new BrowserPage(connection, sessionId, targetId);
    for (const domain of ["Page", "Runtime", "Log", "DOM", "Accessibility"]) {
      await page.command(`${domain}.enable`);
    }
    return page;
  }

  async goto(url: string): Promise<void> {
    await this.command("Page.navigate", { url });
    await this.waitFor("document.readyState === 'complete'", 15_000);
  }

  /** A whole new document from the same URL, which is what an owner's refresh does. */
  async reload(): Promise<void> {
    await this.command("Page.reload", { ignoreCache: false });
    await this.waitFor("document.readyState === 'complete'", 15_000);
  }

  /**
   * Evaluate one expression in the page and return its value.
   *
   * `awaitPromise` lets a check await the page's own work, and `returnByValue` means the harness
   * receives JSON rather than a remote handle it would have to release afterwards. A thrown
   * expression is a harness failure and not a value, so it rejects with the page's own error text.
   */
  async evaluate<T>(expression: string): Promise<T> {
    const result = await this.command("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    const thrown =
      result.text("exceptionDetails.exception.description") ?? result.text("exceptionDetails.text");
    if (thrown !== undefined) {
      throw new Error(`the page threw while evaluating ${expression}: ${thrown}`);
    }
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: returnByValue makes this the JSON the caller's own expression produced, and the caller states the shape it asked that expression for.
    return result.value("result.value") as T;
  }

  /** Wait until a boolean expression holds. A timeout names the expression, not a numeric code. */
  async waitFor(expression: string, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.evaluate<boolean>(`Boolean(${expression})`)) {
        return;
      }
      await sleep(50);
    }
    throw new Error(`waited ${timeoutMs}ms for ${expression}, which never became true`);
  }

  /** The element's box in viewport coordinates, or `undefined` when nothing matches. */
  box(selector: string): Promise<ElementBox | undefined> {
    return this.evaluate<ElementBox | undefined>(
      `(() => {
        const el = document.querySelector(${quoted(selector)});
        if (el === null) { return undefined; }
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height,
          top: r.top, right: r.right, bottom: r.bottom, left: r.left };
      })()`,
    );
  }

  /**
   * Click the element's centre with a real mouse press, after scrolling it into view.
   *
   * `index` names one of several matches, because the transcript's tool disclosures are siblings of
   * other entries and no CSS index expression can count them apart.
   */
  async click(selector: string, index = 0): Promise<void> {
    const box = await this.evaluate<Readonly<{ x: number; y: number; visible: boolean }> | null>(
      `(() => {
        const el = document.querySelectorAll(${quoted(selector)})[${index}];
        if (el === undefined) { return null; }
        el.scrollIntoView({ block: "center", inline: "center" });
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2, visible: r.width > 0 && r.height > 0 };
      })()`,
    );
    if (box === null) {
      throw new Error(`no element matched ${selector} at index ${index}`);
    }
    if (!box.visible) {
      throw new Error(`${selector} has no visible box, so a real click cannot reach it`);
    }
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
      await this.command("Input.dispatchMouseEvent", {
        type,
        x: box.x,
        y: box.y,
        button: "left",
        clickCount: 1,
        buttons: type === "mouseReleased" ? 0 : 1,
      });
    }
  }

  /** Focus a field, select whatever it holds, and insert text over it as typed input. */
  async type(selector: string, text: string): Promise<void> {
    const focused = await this.evaluate<boolean>(
      `(() => {
        const el = document.querySelector(${quoted(selector)});
        if (el === null) { return false; }
        el.focus();
        if (typeof el.select === "function") { el.select(); }
        return document.activeElement === el;
      })()`,
    );
    if (!focused) {
      throw new Error(`could not focus ${selector} to type into it`);
    }
    await this.command("Input.insertText", { text });
  }

  /** Insert text into whatever holds focus, which is the only way a keyboard-only case may type. */
  async insertText(text: string): Promise<void> {
    await this.command("Input.insertText", { text });
  }

  /**
   * Press one key at the browser level, so the page's own focus order decides what receives it.
   *
   * A held modifier is sent as the bitmask DevTools expects rather than as a separate key press,
   * because that is what makes `event.ctrlKey` true in the page. A modified key carries no text:
   * Control-Enter inserts nothing, which is exactly the difference the page's own handler tests.
   */
  async press(key: HarnessKey, held: readonly HarnessModifier[] = []): Promise<void> {
    const descriptor = KEYS[key];
    const modifiers = held.reduce((mask, modifier) => mask | MODIFIERS[modifier], 0);
    for (const type of ["keyDown", "keyUp"]) {
      await this.command("Input.dispatchKeyEvent", {
        type,
        key,
        code: descriptor.code,
        modifiers,
        windowsVirtualKeyCode: descriptor.keyCode,
        nativeVirtualKeyCode: descriptor.keyCode,
        text: type === "keyDown" && modifiers === 0 ? descriptor.text : "",
      });
    }
  }

  /** Resize the viewport, which is how the harness checks the narrow and the wide layout. */
  async setViewport(width: number, height: number): Promise<void> {
    await this.command("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
  }

  /** Every fault the browser reported in this tab, in the order it reported them. */
  consoleErrors(): readonly string[] {
    return this.errors();
  }

  async close(): Promise<void> {
    await this.connection.send("Target.closeTarget", { targetId: this.targetId });
  }

  /** One DevTools command in this tab's session, for the readers that need a domain of their own. */
  command(method: string, params: Record<string, JsonValue> = {}): Promise<CdpResult> {
    return this.connection.send(method, params, this.sessionId);
  }
}
