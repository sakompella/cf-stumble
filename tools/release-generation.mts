import { appendFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import * as Schema from "effect/Schema";
import { execute } from "./e2e/process.mts";
import { GENERATION_1_MODULE_MAP, moduleMapSourceFiles } from "./module-map-build.mts";
import { releaseGeneration, type ReleaseOwner } from "./release-generation/release.mts";

const Status = Schema.Struct({
  activeGeneration: Schema.Struct({
    generation: Schema.NullOr(Schema.Struct({ harnessCommit: Schema.String })),
    epoch: Schema.Number,
  }),
});

const Submission = Schema.Struct({
  outcome: Schema.Struct({ generation: Schema.Struct({ label: Schema.Number }) }),
  preparation: Schema.Union([
    Schema.Struct({
      ok: Schema.Literal(true),
      report: Schema.Struct({ stage: Schema.String, reason: Schema.String }),
    }),
    Schema.Struct({ ok: Schema.Literal(false), problem: Schema.Struct({ code: Schema.String }) }),
  ]),
});

const Refusal = Schema.Struct({ problem: Schema.optional(Schema.Struct({ code: Schema.String })) });

function required(name: string): string {
  const value = process.env[name];

  if (value === undefined || value === "") throw new Error(`${name} is not set`);

  return value;
}

const { values } = parseArgs({ options: { force: { type: "boolean", default: false } } });

const url = required("STUMBLE_URL");

const target = required("TARGET_SHA");

const authorization = `Basic ${Buffer.from(`aditya:${required("OWNER_PASSWORD")}`).toString("base64")}`;

type Answer = Readonly<{ status: number; text: string }>;

type RequestBody = Readonly<Record<string, string | number | boolean>>;

const headers = {
  authorization,
  "content-type": "application/json",
  "user-agent": "cf-stumble-release",
  origin: new URL(url).origin,
};

async function answered(response: Promise<Response>): Promise<Answer> {
  const settled = await response;

  return { status: settled.status, text: await settled.text() };
}

function get(path: string): Promise<Answer> {
  return answered(fetch(`${url}${path}`, { headers }));
}

function post(path: string, body: RequestBody): Promise<Answer> {
  return answered(fetch(`${url}${path}`, { method: "POST", headers, body: JSON.stringify(body) }));
}

async function decoded<S extends Schema.ConstraintDecoder<unknown>>(
  answer: Promise<Answer>,
  schema: S,
) {
  const { status, text } = await answer;

  if (status !== 200) throw new Error(`the owner API answered ${status}: ${text}`);

  return Schema.decodeUnknownSync(Schema.fromJsonString(schema))(text);
}

const owner: ReleaseOwner = {
  async active() {
    const { activeGeneration } = await decoded(get("/api/status"), Status);

    return {
      harnessCommit: activeGeneration.generation?.harnessCommit,
      epoch: activeGeneration.epoch,
    };
  },
  async submit(harnessCommit) {
    const { outcome, preparation } = await decoded(
      post("/api/generations/submit", { harnessCommit }),
      Submission,
    );

    return {
      label: outcome.generation.label,
      ready: preparation.ok && preparation.report.stage === "ready",
      reason: preparation.ok
        ? `${preparation.report.stage}: ${preparation.report.reason}`
        : preparation.problem.code,
    };
  },
  async activate(label, observedEpoch, force) {
    const { status, text } = await post("/api/generations/activate", {
      label,
      observedEpoch,
      force,
    });

    const refusal = Schema.decodeUnknownOption(Schema.fromJsonString(Refusal))(text);

    return {
      ok: status === 200,
      code: refusal._tag === "Some" ? refusal.value.problem?.code : undefined,
    };
  },
};

async function facetChangedSince(harnessCommit: string): Promise<boolean> {
  const files = await moduleMapSourceFiles(GENERATION_1_MODULE_MAP);

  const diff = await execute("git", [
    "diff",
    "--quiet",
    harnessCommit,
    target,
    "--",
    "package.json",
    "pnpm-lock.yaml",
    "tools/module-map-build.mts",
    "tools/build-generation-1.mts",
    ...files,
  ]);

  return diff.code !== 0;
}

const summary = await releaseGeneration(target, {
  owner,
  force: values.force,
  facetChangedSince,
  wait: (ms) => sleep(ms),
  now: Date.now,
});

console.log(summary);

const summaryPath = process.env["GITHUB_STEP_SUMMARY"];

if (summaryPath !== undefined)
  await appendFile(summaryPath, `## Generation release\n\n${summary}\n`);
