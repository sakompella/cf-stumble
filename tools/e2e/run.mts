import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { Owner } from "./owner-api.mts";
import { MINUTE_MS, Steps } from "./steps.mts";
import { Target } from "./target.mts";
import { pageWorkflow, productLoop, selfModification, type Run } from "./workflows.mts";

const { values } = parseArgs({
  options: {
    url: { type: "string" },
    stage: { type: "string" },
    "run-id": { type: "string" },
    keep: { type: "boolean", default: false },
    cleanup: { type: "boolean", default: false },
  },
});

const steps = new Steps();

const password = process.env["E2E_OWNER_PASSWORD"] ?? randomBytes(24).toString("base64url");

const target = new Target({
  runId: values["run-id"] ?? randomBytes(4).toString("hex"),
  url: values.url,
  stage: values.stage,
  password,
  env: process.env,
});

const step = (name: string, limitMs: number, work: (signal: AbortSignal) => Promise<void>) =>
  steps.run(name, limitMs, work);

async function workflows(owner: Owner): Promise<void> {
  const run = (signal: AbortSignal): Run => ({
    id: target.runId,
    owner,
    github: target.github,
    password,
    signal,
  });

  await step("page workflow", 8 * MINUTE_MS, (signal) => pageWorkflow(run(signal)));
  await step("product loop", 12 * MINUTE_MS, (signal) =>
    productLoop(run(signal), (projectId) => {
      target.connectedProject = projectId;
    }),
  );
  await step("self-modification", 20 * MINUTE_MS, (signal) => selfModification(run(signal)));
}

async function cleanUp(): Promise<void> {
  await step("delete branches", 2 * MINUTE_MS, () => target.deleteBranches());

  if (target.fresh) {
    await step("destroy the stage", 15 * MINUTE_MS, () => target.destroy());
  } else {
    await step("restore the target", 2 * MINUTE_MS, () => target.restore());
  }
}

async function main(): Promise<void> {
  let owner: Owner | undefined;

  console.error(`e2e: run ${target.runId}, target ${values.url ?? `stage ${target.stage ?? ""}`}`);

  if (!values.cleanup) {
    await step("deploy and set up", 25 * MINUTE_MS, async () => {
      owner = await target.deploy();
    });

    if (owner !== undefined) await workflows(owner);
  }

  steps.startCleanup();

  if (!values.cleanup) await step("ops:check", 5 * MINUTE_MS, () => target.checkOps());

  if (values.keep) {
    const file = join(tmpdir(), `cf-stumble-e2e-${target.runId}-password`);

    writeFileSync(file, password, { mode: 0o600 });
    console.error(`e2e: kept ${owner?.url ?? "the target"}; the owner password is in ${file}`);
  } else {
    await cleanUp();
  }
}

await main().catch((cause: unknown) => {
  console.error(cause);
});

process.exitCode = steps.report(`e2e run ${target.runId}`) ? 0 : 1;
