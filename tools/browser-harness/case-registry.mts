import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { HarnessCase } from "./case.mjs";

/**
 * Which cases exist, found by looking.
 *
 * Every file in `cases/` that exports `CASES` is a surface module, and no list names them. That is
 * deliberate: six surfaces are written by six agents at the same time, and a central registry file
 * would be the one thing all six had to edit. A file whose name starts with `_` is skipped, which
 * is where one surface keeps the constants its own case files share.
 */

type CaseModule = Readonly<{ CASES: readonly HarnessCase[] }>;

/** A file whose name starts with `_` is one surface's own helper, not a case module. */
function isCaseFile(fileName: string): boolean {
  return fileName.endsWith(".mts") && !fileName.startsWith("_");
}

const CASES_DIRECTORY = new URL("cases/", import.meta.url);

async function loadModule(fileName: string): Promise<readonly HarnessCase[]> {
  const specifier = new URL(fileName, CASES_DIRECTORY).href;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: the shape is checked below, and a module in cases/ that does not export CASES fails by name rather than travelling further.
  const loaded = (await import(specifier)) as CaseModule;
  const cases = loaded.CASES;
  if (cases === undefined) {
    throw new TypeError(`cases/${fileName} does not export CASES: readonly HarnessCase[]`);
  }
  return cases;
}

export async function loadCases(): Promise<readonly HarnessCase[]> {
  const fileNames = (await readdir(fileURLToPath(CASES_DIRECTORY)))
    .filter((name) => isCaseFile(name))
    .toSorted();
  const found: HarnessCase[] = [];
  for (const fileName of fileNames) {
    found.push(...(await loadModule(fileName)));
  }
  const ids = new Set<string>();
  for (const entry of found) {
    if (ids.has(entry.id)) {
      throw new Error(`two cases claim the id ${entry.id}`);
    }
    ids.add(entry.id);
  }
  return found.toSorted((left, right) => order(left.id).localeCompare(order(right.id)));
}

/** `CHAT-2` before `CHAT-10`: the case list numbers its cases, so the run reads in that order. */
function order(caseId: string): string {
  const [surface, number] = caseId.split("-");
  return `${surface ?? caseId}-${(number ?? "").padStart(3, "0")}`;
}
