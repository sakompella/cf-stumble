import { OWNER_PAGE_IDS } from "../../src/page/element-ids.js";
import { BrowserPage } from "./chrome.mjs";
import { startHarnessServer } from "./server.mjs";

/**
 * The smallest end-to-end proof that this harness drives a real browser against the real page.
 *
 * It is deliberately independent of the page's layout and of most of its identifiers, so it keeps
 * working while the page is being rewritten: it asserts that the document arrived, that the root
 * element the page declares is present, that the inline script actually ran (the browser recorded
 * a fetch to the owner API, which only the page's own script issues), and that the browser
 * reported no console error, exception, or Content Security Policy violation.
 *
 * `run.mts` is the full scenario. This file stays as the fast check that the plumbing works.
 */

const steps: string[] = [];

function step(message: string): void {
  steps.push(message);
  console.log(`  ${message}`);
}

async function smoke(): Promise<void> {
  const server = await startHarnessServer("ready");
  step(`harness server on ${server.url}`);
  const page = await BrowserPage.launch();
  step("launched Chrome and attached over the DevTools Protocol");

  try {
    await page.setViewport(1280, 900);
    await page.goto(`${server.url}/`);
    step("loaded the owner page");

    const title = await page.evaluate<string>("document.title");
    if (title !== "cf-stumble") {
      throw new Error(`expected the page title "cf-stumble", read "${title}"`);
    }
    step(`document.title is ${title}`);

    const rootPresent = await page.evaluate<boolean>(
      `document.getElementById("${OWNER_PAGE_IDS.root}") !== null`,
    );
    if (!rootPresent) {
      throw new Error(`the page has no element with id "${OWNER_PAGE_IDS.root}"`);
    }
    step(`found the root element #${OWNER_PAGE_IDS.root}`);

    await page.waitFor(
      `performance.getEntriesByType("resource").some((entry) => entry.name.includes("/api/"))`,
      10_000,
    );
    step("the inline script ran: the browser recorded a fetch to the owner API");

    const errors = page.consoleErrors();
    if (errors.length > 0) {
      throw new Error(`the browser reported ${errors.length} fault(s):\n${errors.join("\n")}`);
    }
    step("no console error, exception, or CSP violation");
  } finally {
    await page.close();
    await server.close();
  }
}

console.log("browser-harness smoke check");
try {
  await smoke();
  console.log("PASS");
} catch (error) {
  console.error("FAIL");
  console.error(error instanceof Error ? error.message : String(error));
  console.error(`completed steps: ${steps.length}`);
  process.exitCode = 1;
}
