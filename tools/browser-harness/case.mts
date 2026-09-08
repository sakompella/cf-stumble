import type { BrowserPage } from "./chrome.mjs";
import type { HarnessScenario } from "./fixtures.mjs";
import type { HarnessServer } from "./server.mjs";

/**
 * What a case is, and what it receives.
 *
 * One case is one observation about the real page, made in its own server and its own tab. The
 * runner owns everything that is the same for every case — the browser, the viewport, the first
 * navigation, the per-case timeout, and the browser-fault and request-failure checks — so a case
 * body contains only the acting and the asserting that make it that case.
 *
 * A case answers with the evidence it gathered. The runner prints that line and fails the case if
 * it is empty, which is how "assert a nonempty named result" is enforced rather than remembered.
 */

export type CaseViewport = Readonly<{ width: number; height: number }>;

export type CaseContext = Readonly<{
  page: BrowserPage;
  server: HarnessServer;
  /**
   * A fresh page against fresh server state, optionally in another scenario. Cases that compare
   * several endings of the same turn need each ending to start from revision 3 again.
   */
  reopen: (scenario?: HarnessScenario) => Promise<void>;
}>;

export type HarnessCase = Readonly<{
  /** The case id from `.audit/v0/web-test-cases.md`, which names the surface before the dash. */
  id: string;
  title: string;
  rank: "must" | "should";
  scenario: HarnessScenario;
  /** 1280×900 unless the case is about the layout at another size. */
  viewport?: CaseViewport;
  /**
   * `settled` navigates and waits for the status, project, and thread reads to answer. `loaded`
   * navigates and waits for the document only. `blank` leaves the navigation to the case.
   */
  start?: "settled" | "loaded" | "blank";
  timeoutMs?: number;
  /**
   * The `"<METHOD> <path>"` requests this case expects the stub to refuse. Every other 4xx or 5xx
   * answer to a same-origin request fails the case, because a page that asks for something the
   * Worker does not serve is a fault a reader would eventually meet.
   */
  allowedRequestFailures?: readonly string[];
  run: (context: CaseContext) => Promise<string>;
}>;

export const DEFAULT_VIEWPORT: CaseViewport = { width: 1280, height: 900 };
export const DEFAULT_CASE_TIMEOUT_MS = 60_000;

export function surfaceOf(caseId: string): string {
  return caseId.split("-")[0] ?? caseId;
}
