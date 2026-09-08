import type { HarnessChrome } from "./browser.mjs";
import {
  DEFAULT_CASE_TIMEOUT_MS,
  DEFAULT_VIEWPORT,
  type CaseContext,
  type HarnessCase,
} from "./case.mjs";
import type { BrowserPage } from "./chrome.mjs";
import { assertNonEmpty } from "./expect.mjs";
import { waitForSettledReads } from "./page-wait.mjs";
import { startHarnessServer, type HarnessServer } from "./server.mjs";

/**
 * Running one case: its own stub server, its own tab, and the checks every case is held to.
 *
 * The three shared checks live here rather than in each case because a case that had to remember
 * them would eventually forget one. A case fails if it returns no evidence, if the browser
 * reported a console error, an uncaught exception, or a policy violation, or if the page asked the
 * stub for something the stub refused and the case did not say it expected that refusal.
 */

export type CaseOutcome = Readonly<{
  id: string;
  title: string;
  rank: string;
  passed: boolean;
  evidence: string;
  reason: string;
  durationMs: number;
}>;

async function withTimeout<T>(work: Promise<T>, timeoutMs: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_answer, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${what} did not finish in ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([work, guard]);
  } finally {
    clearTimeout(timer);
    // A timed-out case leaves its own work in flight. Nothing may act on it, but an unobserved
    // rejection would end the whole run instead of this one case.
    void work.catch(() => null);
  }
}

/**
 * A refused same-origin request the case did not name.
 *
 * The scenarios that exist to be refused — a busy project, no active generation, a stale epoch —
 * pass that path in `allowedRequestFailures`, so anything else here is the page reaching for
 * something this Worker does not serve.
 */
function unexpectedRefusals(server: HarnessServer, allowed: readonly string[]): readonly string[] {
  return server
    .requests()
    .filter((request) => request.status >= 400)
    .map((request) => `${request.method} ${request.path} answered ${request.status}`)
    .filter((described) => !allowed.some((entry) => described.startsWith(entry)));
}

/** A browser fault, except the network error the case already declared it expected. */
function browserFaults(faults: readonly string[], allowed: readonly string[]): readonly string[] {
  const paths = allowed.map((entry) => entry.slice(entry.indexOf(" ") + 1));
  return faults.filter(
    (fault) => !fault.startsWith("log[network/") || !paths.some((path) => fault.includes(path)),
  );
}

function enforce(
  page: BrowserPage,
  server: HarnessServer,
  evidence: string,
  entry: HarnessCase,
): void {
  const allowed = entry.allowedRequestFailures ?? [];
  assertNonEmpty(evidence, `${entry.id} reported no result`);
  const faults = browserFaults(page.consoleErrors(), allowed);
  if (faults.length > 0) {
    throw new Error(`the browser reported ${faults.length} fault(s):\n  ${faults.join("\n  ")}`);
  }
  const refused = unexpectedRefusals(server, allowed);
  if (refused.length > 0) {
    throw new Error(`the page made a request this Worker refused:\n  ${refused.join("\n  ")}`);
  }
}

async function openCase(
  entry: HarnessCase,
  page: BrowserPage,
  server: HarnessServer,
): Promise<void> {
  const viewport = entry.viewport ?? DEFAULT_VIEWPORT;
  await page.setViewport(viewport.width, viewport.height);
  const start = entry.start ?? "settled";
  if (start !== "blank") {
    await page.goto(`${server.url}/`);
  }
  if (start === "settled") {
    await waitForSettledReads(page);
  }
}

function outcome(
  entry: HarnessCase,
  started: number,
  evidence: string,
  reason: string,
): CaseOutcome {
  return {
    id: entry.id,
    title: entry.title,
    rank: entry.rank,
    passed: reason === "",
    evidence,
    reason,
    durationMs: Date.now() - started,
  };
}

export async function runCase(chrome: HarnessChrome, entry: HarnessCase): Promise<CaseOutcome> {
  const started = Date.now();
  const server = await startHarnessServer(entry.scenario);
  const page = await chrome.openPage();
  const context: CaseContext = {
    page,
    server,
    reopen: async (scenario) => {
      server.reset(scenario);
      await page.goto(`${server.url}/`);
      await waitForSettledReads(page);
    },
  };
  try {
    await openCase(entry, page, server);
    const evidence = await withTimeout(
      entry.run(context),
      entry.timeoutMs ?? DEFAULT_CASE_TIMEOUT_MS,
      entry.id,
    );
    enforce(page, server, evidence, entry);
    return outcome(entry, started, evidence, "");
  } catch (error) {
    return outcome(entry, started, "", error instanceof Error ? error.message : String(error));
  } finally {
    await page.close();
    await server.close();
  }
}
