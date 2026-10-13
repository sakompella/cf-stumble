import { isJsonArray, isJsonRecord, isJsonString } from "../json.mjs";
import { parseJsonRecord, type CdpResult } from "../browser-harness/cdp.mjs";
import { ToolError } from "./error.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Bidi } from "./bidi.mjs";
import { isApprovalText, isCallbackUrl, matchesAccount, redactPageText } from "./options.mjs";

function actionExpression(inspect: boolean, account: string): string {
  // The page code stays in a string because it executes in Firefox, not Node.
  return String.raw`(() => {
    if (location.hostname !== "auth.openai.com" || !document.body?.innerText.trim()) return "waiting";
    const visible = el => el.getClientRects().length > 0 && !el.disabled && el.getAttribute("aria-disabled") !== "true";
    const buttons = [...document.querySelectorAll('button, [role="button"], input[type="submit"]')].filter(visible);
    const text = el => [el.getAttribute("aria-label"), el.innerText, el.value].filter(Boolean).join(" ").trim();
    const chooser = /choose an account|select an account/i.test(document.body.innerText);
    if (chooser) {
      const accounts = buttons.filter(el => !/^remove account/i.test(text(el)) && /[^\s@]+@[^\s@]+\.[^\s@]+/.test(text(el)));
      const matches = accounts.filter(el => (${matchesAccount.toString()})(text(el), [...el.querySelectorAll("span, p, div")].map(part => part.textContent), ${JSON.stringify(account)}));
      if (matches.length === 1) { const rect = matches[0].getBoundingClientRect(); return JSON.stringify({ x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) }); }
      return "account choice needed";
    }
    if (/performing security verification|verify you are (?:not a bot|human)|checking your browser/i.test(document.body.innerText)) return "blocked";
    if (/oops, an error occurred|route error/i.test(document.body.innerText)) return "blocked";
    if (${JSON.stringify(inspect)}) return "inspection";
    const name = document.querySelector('input[name="agent_name"], input[name="name"], input[placeholder*="agent" i]');
    if (name && !name.value.trim()) {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(name, "cf-stumble");
      name.dispatchEvent(new Event("input", { bubbles: true }));
      name.dispatchEvent(new Event("change", { bubbles: true }));
      return "name filled";
    }
    const button = buttons.find(el => (${isApprovalText.toString()})(text(el)));
    if (button) { button.click(); return "clicked"; }
    return "waiting";
  })()`;
}

export async function saveDiagnostics(
  bidi: Bidi,
  context: string,
  network: readonly string[],
): Promise<string> {
  const directory = join("/tmp", `chatgpt-connect-${Date.now()}`);

  await mkdir(directory, { mode: 0o700 });

  const page = await bidi.send("script.evaluate", {
    expression: String.raw`document.body.innerText + "\n\nControls:\n" + [...document.querySelectorAll("button, input")].map(el => [el.tagName, el.type, el.getAttribute("aria-label"), el.innerText, el.placeholder].filter(Boolean).join(" | ")).join("\n")`,
    target: { context },
    awaitPromise: true,
  });

  await writeFile(join(directory, "network.txt"), network.join("\n"), { mode: 0o600 });

  const screenshot = await bidi.send("browsingContext.captureScreenshot", { context });
  const data = screenshot.text("result.data");

  await writeFile(
    join(directory, "page.txt"),
    redactPageText(page.text("result.result.value") ?? ""),
    { mode: 0o600 },
  );

  if (data !== undefined) {
    await writeFile(join(directory, "page.png"), Buffer.from(data, "base64"), { mode: 0o600 });
  }

  return directory;
}

export async function drivePage(
  bidi: Bidi,
  authorizeUrl: string,
  inspect: boolean,
  timeoutMs: number,
  signal: AbortSignal,
  account: string,
): Promise<string> {
  const context = await createContext(bidi);

  const network: string[] = [];
  const capturedCallback = await interceptCallback(bidi, network);

  await bidi.send("browsingContext.navigate", { context, url: authorizeUrl, wait: "none" });
  await sleep(2000, undefined, { signal });

  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline && !signal.aborted) {
    const callback = capturedCallback();

    if (callback !== undefined) {
      return callback;
    }

    const action = await pageAction(bidi, context, inspect, account);
    const click = parseJsonRecord(action ?? "");
    const x = click?.count("x");
    const y = click?.count("y");

    if (x !== undefined && y !== undefined) {
      await pointerClick(bidi, context, x, y);
      await sleep(2000, undefined, { signal });
      continue;
    }

    if (action === "blocked" || action === "account choice needed") {
      await failPage(bidi, context, network, action);
    }

    if (inspect && action === "inspection") {
      const directory = await saveDiagnostics(bidi, context, network);

      console.log(`Inspection saved to ${directory}; no consent submitted`);

      return "";
    }

    await sleep(750, undefined, { signal });
  }

  if (signal.aborted) {
    throw new ToolError("Interrupted");
  }

  const directory = await saveDiagnostics(bidi, context, network);

  throw new ToolError(`ChatGPT login timed out; diagnostics saved to ${directory}`);
}

async function interceptCallback(bidi: Bidi, network: string[]): Promise<() => string | undefined> {
  let callback: string | undefined;
  let interceptFailure = false;

  bidi.onEvent((event) => {
    recordNetwork(event, network);

    const url = event.text("params.request.url");
    const request = event.text("params.request.request");

    if (
      event.text("method") === "network.beforeRequestSent" &&
      url !== undefined &&
      request !== undefined &&
      isCallbackUrl(url) &&
      event.value("params.isBlocked") === true
    ) {
      void bidi
        .send("network.failRequest", { request })
        .then(() => {
          callback = url;
        })
        .catch(() => {
          interceptFailure = true;
        });
    }
  });
  await bidi.send("network.addIntercept", {
    phases: ["beforeRequestSent"],
    urlPatterns: [
      {
        type: "pattern",
        protocol: "http",
        hostname: "127.0.0.1",
        port: "1455",
        pathname: "/auth/callback",
      },
    ],
  });
  await bidi.send("session.subscribe", {
    events: ["network.beforeRequestSent", "network.responseCompleted", "network.fetchError"],
  });

  return () => {
    if (interceptFailure) {
      throw new ToolError("Could not block the OAuth callback");
    }

    return callback;
  };
}

async function pointerClick(bidi: Bidi, context: string, x: number, y: number): Promise<void> {
  await bidi.send("input.performActions", {
    context,
    actions: [
      {
        type: "pointer",
        id: "mouse",
        parameters: { pointerType: "mouse" },
        actions: [
          { type: "pointerMove", x, y, duration: 0 },
          { type: "pointerDown", button: 0 },
          { type: "pointerUp", button: 0 },
        ],
      },
    ],
  });
}

function recordNetwork(event: CdpResult, network: string[]): void {
  const rawUrl = event.text("params.request.url");

  if (rawUrl === undefined || new URL(rawUrl).hostname !== "auth.openai.com") {
    return;
  }

  const url = new URL(rawUrl);

  if (!url.pathname.startsWith("/api/accounts/") && url.pathname !== "/choose-an-account") {
    return;
  }

  const headers = event.value("params.request.headers");
  let contentType = "none";

  if (headers !== undefined && isJsonArray(headers)) {
    for (const header of headers) {
      if (!isJsonRecord(header)) {
        continue;
      }

      const name = header["name"];
      const value = header["value"];

      if (
        name === undefined ||
        !isJsonString(name) ||
        name.toLowerCase() !== "content-type" ||
        value === undefined ||
        !isJsonRecord(value)
      ) {
        continue;
      }

      const text = value["value"];

      if (text !== undefined && isJsonString(text)) {
        contentType = text;
      }
    }
  }

  network.push(
    `${event.text("method") ?? "event"} ${event.text("params.request.method") ?? "?"} ${url.pathname} status=${event.count("params.response.status") ?? "-"} content-type=${contentType}`,
  );
}

async function createContext(bidi: Bidi): Promise<string> {
  await bidi.send("session.new", { capabilities: {} });
  const tree = await bidi.send("browsingContext.getTree");
  let context = tree.text("result.contexts.0.context");

  context ??= (await bidi.send("browsingContext.create", { type: "tab" })).text("result.context");

  if (context === undefined) {
    throw new ToolError("Firefox did not create a page");
  }

  return context;
}

async function pageAction(
  bidi: Bidi,
  context: string,
  inspect: boolean,
  account: string,
): Promise<string | undefined> {
  const result = await bidi.send("script.evaluate", {
    expression: actionExpression(inspect, account),
    target: { context },
    awaitPromise: true,
  });

  return result.text("result.result.value");
}

async function failPage(
  bidi: Bidi,
  context: string,
  network: readonly string[],
  action: string,
): Promise<never> {
  const directory = await saveDiagnostics(bidi, context, network);

  const reason =
    action === "blocked"
      ? "OpenAI blocked this browser; try --headed or the page's manual Connect ChatGPT flow"
      : "No unique account match; pass --account";

  throw new ToolError(`${reason}; diagnostics saved to ${directory}`);
}
