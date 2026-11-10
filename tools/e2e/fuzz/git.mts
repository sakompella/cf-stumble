import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import type { Owner } from "../owner-api.mts";
import { stopChildren } from "../process.mts";
import { deployEnv, deployStage } from "../cloudflare.mts";
import { Target } from "../target.mts";
import { fuzzGit } from "./git-fuzz.mts";
import {
  installScriptedGeneration,
  pushBranch,
  runSteps,
  scriptedCommit,
} from "./scripted-generation.mts";

const { values } = parseArgs({
  options: {
    seed: { type: "string", default: "1" },
    minutes: { type: "string", default: "30" },
    stage: { type: "string" },
    "run-id": { type: "string" },
    keep: { type: "boolean", default: false },
    redeploy: { type: "boolean", default: false },
    cleanup: { type: "boolean", default: false },
  },
});

const interrupted = new AbortController();

const password = process.env["E2E_OWNER_PASSWORD"] ?? randomBytes(24).toString("base64url");

const target = new Target({
  runId: values["run-id"] ?? randomBytes(4).toString("hex"),
  url: undefined,
  stage: values.stage,
  stagePrefix: "fzgit",
  password,
  env: process.env,
});

process.on("SIGINT", () => {
  interrupted.abort(new Error("SIGINT"));
  stopChildren();
});

function installed(owner: Owner): Promise<boolean> {
  const probe = { tool: "bash", args: { command: "true", backend: "isolate" } } as const;

  return runSteps(owner, [probe], interrupted.signal).then(
    () => true,
    () => false,
  );
}

async function main(): Promise<boolean> {
  if (values.redeploy && values.stage !== undefined)
    await deployStage(values.stage, await deployEnv(process.env), ["--force"]);

  const owner = await target.deploy();
  const token = process.env["GH_TOKEN"] ?? "";

  if (!(await installed(owner))) {
    const branch = `e2e/${target.runId}-gen`;
    const sha = await scriptedCommit();

    await pushBranch(sha, branch, token);
    await installScriptedGeneration(owner, sha, branch, interrupted.signal);
  }

  const report = await fuzzGit({
    seed: Number(values.seed),
    deadline: Date.now() + Number(values.minutes) * 60_000,
    runId: target.runId,
    owner,
    github: target.github,
    token,
    signal: interrupted.signal,
  });

  console.error(
    `fuzz git: seed ${values.seed}: ${report.rounds} rounds, ${report.steps} comparisons, ${report.divergences.length} divergences`,
  );

  for (const [name, count] of report.classes) console.error(`  ${count} x ${name}`);

  return report.divergences.length === 0;
}

console.error(`fuzz git: run ${target.runId}, stage ${target.stage ?? "?"}`);

let failed = false;

try {
  if (!values.cleanup) failed = !(await main());
} catch (cause) {
  failed = true;
  console.error(cause);
}

if (!values.keep) {
  await target.deleteBranches().catch(console.error);
  await target.destroy().catch((cause: unknown) => {
    failed = true;
    console.error(cause);
  });
}

process.exitCode = failed ? 1 : 0;
