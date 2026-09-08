import { resolve } from "node:path";
import { HarnessChrome } from "./browser.mjs";
import { surfaceOf, type HarnessCase } from "./case.mjs";
import { loadCases } from "./case-registry.mjs";
import { runCase, type CaseOutcome } from "./case-run.mjs";

/**
 * The browser check: every registered case, each in its own stub server and its own tab, against
 * the real owner page.
 *
 * This runs outside the commit gate because it needs a local Chromium and about a minute, and
 * `pnpm verify` must stay fast enough to run before every commit. What it buys is the only
 * evidence that exists for the page itself: `pnpm verify` never opens a browser, so it cannot see
 * that the conversation streams, that the sidebar fills in, or that the layout survives a phone.
 *
 * `--only <token>` narrows the run by case id or by surface, so a case can be iterated on in a
 * second or two: `--only CHAT-2`, `--only chat`, `--only smoke`.
 */

function selected(cases: readonly HarnessCase[], only: string | undefined): readonly HarnessCase[] {
  if (only === undefined) {
    return cases;
  }
  const wanted = only.toUpperCase();
  return cases.filter(
    (entry) => entry.id.toUpperCase() === wanted || surfaceOf(entry.id).toUpperCase() === wanted,
  );
}

function argumentValue(argv: readonly string[], flag: string): string | undefined {
  const at = argv.indexOf(flag);
  return at < 0 ? undefined : argv[at + 1];
}

function report(outcome: CaseOutcome): void {
  const seconds = (outcome.durationMs / 1000).toFixed(1);
  if (outcome.passed) {
    console.log(`PASS ${outcome.id} ${outcome.title} (${seconds}s)`);
    console.log(`     ${outcome.evidence}`);
    return;
  }
  console.log(`FAIL ${outcome.id} ${outcome.title} (${seconds}s) [${outcome.rank}]`);
  for (const line of outcome.reason.split("\n")) {
    console.log(`     ${line}`);
  }
}

function summarise(outcomes: readonly CaseOutcome[]): number {
  const failed = outcomes.filter((outcome) => !outcome.passed);
  const musts = failed.filter((outcome) => outcome.rank === "must");
  const mustNote = musts.length > 0 ? `, ${musts.length} of them ranked must` : "";
  console.log("");
  console.log(
    `${outcomes.length} case(s): ${outcomes.length - failed.length} passed, ` +
      `${failed.length} failed${mustNote}`,
  );
  if (failed.length > 0) {
    console.log(`failed: ${failed.map((outcome) => outcome.id).join(", ")}`);
  }
  return failed.length === 0 ? 0 : 1;
}

export async function runHarness(argv: readonly string[]): Promise<number> {
  const cases = selected(await loadCases(), argumentValue(argv, "--only"));
  if (argv.includes("--list")) {
    for (const entry of cases) {
      console.log(`${entry.id} [${entry.rank}] ${entry.title} (${entry.scenario})`);
    }
    return 0;
  }
  if (cases.length === 0) {
    console.error("no case matched --only; run with --list to see the registered cases");
    return 1;
  }
  const chrome = await HarnessChrome.launch();
  console.log(`browser-harness: ${cases.length} case(s) in ${chrome.executable}`);
  const outcomes: CaseOutcome[] = [];
  try {
    for (const entry of cases) {
      const outcome = await runCase(chrome, entry);
      report(outcome);
      outcomes.push(outcome);
    }
  } finally {
    await chrome.close();
  }
  return summarise(outcomes);
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename;

if (invokedDirectly) {
  process.exitCode = await runHarness(process.argv.slice(2));
}
