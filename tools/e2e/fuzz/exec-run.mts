import { appendFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { routedBackend } from "../../../src/workspace/project/exec-routing.ts";
import { Rng, generateCase, type Case } from "./exec-gen.mts";
import { judge, stepsFor, type CaseSteps } from "./exec-oracle.mts";
import { freshThread, installFuzzGeneration, runSteps } from "./exec-session.mts";
import { withStage, type FuzzRun } from "./exec-stage.mts";

const BATCH = 5;

const PROBE_FIXTURES = [
  { path: "a.txt", base64: Buffer.from("hello\nworld\n").toString("base64") },
  { path: "sub/x.txt", base64: Buffer.from("x\n").toString("base64") },
];

type Failure = Readonly<{ item: Case; problems: readonly string[] }>;

async function runBatch(run: FuzzRun, items: readonly Case[]): Promise<readonly Failure[]> {
  const planned = items.map((item): [Case, CaseSteps] => [
    item,
    stepsFor(
      run.runId,
      item,
      routedBackend(item.command) === "isolate",
      `fz-${run.runId}-${item.id}`,
    ),
  ]);

  const observed = await runSteps(
    run,
    planned.flatMap(([, { steps }]) => [...steps]),
  );

  const failures: Failure[] = [];
  let offset = 0;

  for (const [item, { steps, variants }] of planned) {
    const mine = observed.slice(offset, offset + steps.length);
    const { problems } = judge(variants, mine);

    offset += steps.length;

    if (problems.length > 0) failures.push({ item, problems });
  }

  await freshThread(run);

  return failures;
}

function nextBatch(rng: Rng, commands: readonly string[], firstId: number): readonly Case[] {
  if (commands.length === 0) {
    return Array.from({ length: BATCH }, (_, offset) => generateCase(rng, firstId + offset));
  }

  return commands.map((command, offset) => ({
    id: firstId + offset,
    command,
    fixtures: PROBE_FIXTURES,
    timeout: 30,
  }));
}

function record(seed: number, failure: Failure): void {
  appendFileSync(`/tmp/fuzz-exec-${seed}.jsonl`, `${JSON.stringify(failure)}\n`);
  console.error(
    `fuzz: FAIL seed ${seed} case ${failure.item.id}: ${JSON.stringify(failure.item.command)}\n  ${failure.problems.join("\n  ")}`,
  );
}

async function fuzz(run: FuzzRun, commands: readonly string[]): Promise<boolean> {
  await installFuzzGeneration(run);

  const rng = new Rng(run.seed);
  const deadline = Date.now() + run.minutes * 60_000;
  let failed = 0;
  let cases = 0;

  while (Date.now() < deadline && !run.signal.aborted) {
    const items = nextBatch(rng, commands, cases);

    const failures = await runBatch(run, items).catch((cause: unknown) =>
      items.map((item) => ({ item, problems: [`batch broke: ${String(cause)}`] })),
    );

    for (const failure of failures) record(run.seed, failure);

    failed += failures.length;
    cases += items.length;

    if (commands.length > 0) break;
  }

  console.error(`fuzz exec: seed ${run.seed}, ${cases} cases, ${failed} failures`);

  return failed === 0;
}

const { values } = parseArgs({
  options: {
    seed: { type: "string", default: String(Date.now() % 1_000_000) },
    minutes: { type: "string", default: "30" },
    stage: { type: "string" },
    keep: { type: "boolean", default: false },
    command: { type: "string", multiple: true },
  },
});

const passed = await withStage(
  "exec",
  {
    seed: Number(values.seed),
    minutes: Number(values.minutes),
    stage: values.stage,
    keep: values.keep,
  },
  (run) => fuzz(run, values.command ?? []),
);

console.error(`fuzz exec: ${passed ? "PASS" : "FAIL"}`);

process.exitCode = passed ? 0 : 1;
