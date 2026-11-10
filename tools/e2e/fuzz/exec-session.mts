import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import * as Schema from "effect/Schema";
import type { FuzzRun } from "./exec-stage.mts";
import { FuzzCommits } from "./exec-commit.mts";

const HARNESS_PROJECT = "harness";

const Text = Schema.Struct({
  content: Schema.Array(Schema.Struct({ text: Schema.optional(Schema.String) })),
  isError: Schema.optional(Schema.Boolean),
});

const Page = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({ id: Schema.Number, kind: Schema.String, model: Schema.Array(Schema.Unknown) }),
  ),
});

const Digest = Schema.Struct({
  bytes: Schema.Number,
  lines: Schema.Number,
  sha256: Schema.String,
  text: Schema.NullOr(Schema.String),
  head: Schema.String,
  tail: Schema.String,
});

const Reported = Schema.Struct({
  ok: Schema.Boolean,
  exitCode: Schema.NullOr(Schema.Number),
  error: Schema.NullOr(Schema.String),
  ms: Schema.Number,
  stdout: Digest,
  stderr: Digest,
  spill: Schema.NullOr(
    Schema.Struct({
      path: Schema.String,
      readable: Schema.Boolean,
      content: Schema.NullOr(Digest),
    }),
  ),
});

export type Step = Readonly<{
  command: string;
  backend?: "isolate" | "container";
  timeout?: number;
  cwd?: string;
}>;

export type Outcome = typeof Reported.Type;

export type Observation = Outcome | Readonly<{ toolError: string }>;

const decodeText = Schema.decodeUnknownSync(Text);

const decodePage = Schema.decodeUnknownSync(Page);

const decodeReported = Schema.decodeUnknownSync(Schema.fromJsonString(Reported));

async function fetchBranch(run: FuzzRun, branch: string): Promise<void> {
  const prompt = [
    "Run this with the bash tool, in the container, and nothing else:",
    `git -C /workspace/harness fetch origin ${branch}`,
    "Then reply with the single word fetched.",
  ].join("\n");

  for (let attempt = 1; ; attempt++) {
    await run.owner.send(HARNESS_PROJECT, prompt);

    const settled = await run.owner.waitSettled(HARNESS_PROJECT, run.signal);

    if (settled.failure === undefined) return;

    if (attempt === 4)
      throw new Error(`fetching ${branch} through the model failed: ${settled.failure}`);

    await sleep(30_000, undefined, { signal: run.signal });
  }
}

const FACET_PATH = "src/facet/generation-1/fuzz-exec.ts";

export async function installFuzzGeneration(run: FuzzRun): Promise<void> {
  const active = (await run.owner.status()).generation;

  if (active !== null && (await run.github.fileAt(FACET_PATH, active.harnessCommit)) !== undefined)
    return;

  const base = await run.github.mainHead();
  const branch = `e2e/${run.runId}-fuzz`;
  const facet = readFileSync(new URL("./exec-facet.ts", import.meta.url), "utf8");
  const commit = await new FuzzCommits(run.token).branchWithFacet(base, branch, facet);

  await fetchBranch(run, branch);

  const label = await run.owner.submit(commit);

  await run.owner.control("activate", label);

  for (;;) {
    const { generation } = await run.owner.status();

    if (generation?.harnessCommit === commit) return;

    await sleep(3_000, undefined, { signal: run.signal });
  }
}

async function lastEntryId(run: FuzzRun): Promise<number> {
  const page = decodePage(
    await (await run.owner.get(`/api/projects/${HARNESS_PROJECT}/entries?limit=1`)).json(),
  );

  return page.items[0]?.id ?? 0;
}

async function toolResults(run: FuzzRun, after: number): Promise<readonly Observation[]> {
  const observed: Observation[] = [];

  for (let min = after + 1; ;) {
    const response = await run.owner.get(
      `/api/projects/${HARNESS_PROJECT}/entries?order=ascending&limit=100&min=${min}`,
    );

    const { items } = decodePage(await response.json());

    for (const entry of items) {
      if (entry.kind !== "pi.tool-result") continue;

      const result = decodeText(entry.model[0]);
      const text = result.content.map((part) => part.text ?? "").join("");

      try {
        observed.push(decodeReported(text));
      } catch {
        observed.push({ toolError: text });
      }
    }

    const last = items.at(-1);

    if (last === undefined || items.length < 100) return observed;

    min = last.id + 1;
  }
}

export async function freshThread(run: FuzzRun): Promise<void> {
  await run.owner.post(`/api/projects/${HARNESS_PROJECT}/thread/fresh`);
}

export async function runSteps(
  run: FuzzRun,
  steps: readonly Step[],
): Promise<readonly Observation[]> {
  const before = await lastEntryId(run);

  await run.owner.send(HARNESS_PROJECT, `fuzz-exec:${JSON.stringify(steps)}`);

  const settled = await run.owner.waitSettled(HARNESS_PROJECT, run.signal);

  if (settled.failure !== undefined) throw new Error(`the run stopped: ${settled.failure}`);

  const results = await toolResults(run, before);

  if (results.length !== steps.length) {
    throw new Error(`${steps.length} steps produced ${results.length} tool results`);
  }

  return results;
}
