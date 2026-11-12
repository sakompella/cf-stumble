import { signature, type Case } from "./git-data.mts";
import type { Outcome } from "./git-oracle.mts";

export type Divergence = Readonly<{
  round: number;
  index: number;
  label: string;
  kind: string;
  command: string;
  oracle: Outcome;
  stage: Outcome;
}>;

const HASHED = new Set([
  "commit",
  "reset",
  "checkout",
  "branch",
  "push",
  "fetch",
  "read",
  "rm",
  "mv",
]);

const STABLE_HASHES = /^(?:diff|cat-file|ls-files|show)\b/u;

export function normalize(text: string, item: Case | undefined, roots: readonly string[]): string {
  const subcommand = (item?.command ?? "").replace(/^git\s+/u, "");
  const hashed = item !== undefined && HASHED.has(item.kind) && !STABLE_HASHES.test(subcommand);

  let out = text.replaceAll("\r\n", "\n");

  for (const root of roots) out = out.replaceAll(root, "");

  out = out
    .replaceAll(/^remote: .*\n/gmu, "")
    .replaceAll(/^To .*$/gmu, "To <remote>")
    .replaceAll(/^From .*$/gmu, "From <remote>")
    .replaceAll(/(failed to push some refs to )'.*'/gu, "$1'<remote>'")
    .replaceAll(/^(\s*)Date: .*$/gmu, "$1Date: <date>");

  if (hashed) out = out.replaceAll(/\b[0-9a-f]{7,40}\b/gu, "<sha>");

  return out.trimEnd();
}

export function matches(oracle: Outcome, stage: Outcome): boolean {
  return oracle.code === stage.code && oracle.output === stage.output;
}

export function firstDifference(oracle: string, stage: string): string {
  const left = oracle.split("\n");
  const right = stage.split("\n");
  const at = left.findIndex((line, index) => line !== right[index]);
  const index = at === -1 ? left.length : at;

  return `line ${index + 1}: oracle ${JSON.stringify(left[index] ?? "<end>")} stage ${JSON.stringify(right[index] ?? "<end>")}`;
}

export function classify(found: Divergence): string {
  const exits = found.oracle.code !== found.stage.code;
  const what = exits ? `exit ${found.oracle.code} vs ${found.stage.code}` : "output";
  const form = found.kind === "fs" ? "fs" : signature(found.command);

  return `${found.label} ${form}: ${what}`;
}

function excerpt(text: string): string {
  return text.length > 700 ? `${text.slice(0, 700)}...` : text;
}

export function describe(found: Divergence): string {
  return [
    `round ${found.round} step ${found.index} (${found.label}): ${found.command}`,
    `  ${firstDifference(found.oracle.output, found.stage.output)}`,
    `  oracle exit ${found.oracle.code}:\n${excerpt(found.oracle.output)}`,
    `  stage exit ${found.stage.code}:\n${excerpt(found.stage.output)}`,
  ].join("\n");
}
