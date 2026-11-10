import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { Owner } from "./owner-api.mts";
import { stopChildren } from "./process.mts";
import { Target } from "./target.mts";
import { pageWorkflow, productLoop, selfModification, type Run } from "./workflows.mts";

const MINUTE_MS = 60_000;

const { values } = parseArgs({
  options: {
    url: { type: "string" },
    stage: { type: "string" },
    "run-id": { type: "string" },
    keep: { type: "boolean", default: false },
    cleanup: { type: "boolean", default: false },
  },
});

type Outcome = Readonly<{ name: string; ok: boolean; seconds: number; detail: string }>;

const outcomes: Outcome[] = [];

const interrupted = new AbortController();

const startedMs = Date.now();

const password = process.env["E2E_OWNER_PASSWORD"] ?? randomBytes(24).toString("base64url");

const target = new Target({
  runId: values["run-id"] ?? randomBytes(4).toString("hex"),
  url: values.url,
  stage: values.stage,
  password,
  env: process.env,
});

let cleaning = false;

function onSignal(signal: NodeJS.Signals): void {
  console.error(`e2e: ${signal}, ${cleaning ? "cleanup continues" : "stopping, then cleaning up"}`);

  if (cleaning) return;

  interrupted.abort(new Error(signal));
  stopChildren();
}

process.on("SIGINT", onSignal);

process.on("SIGTERM", onSignal);

function describe(cause: unknown): string {
  if (!(cause instanceof Error)) return String(cause);

  const inner = cause.cause === undefined ? "" : describe(cause.cause);

  return cause.message.includes(inner) ? cause.message : `${cause.message} (${inner})`;
}

async function step(name: string, limitMs: number, work: (signal: AbortSignal) => Promise<void>) {
  const began = Date.now();
  const limit = AbortSignal.timeout(limitMs);
  const signal = cleaning ? limit : AbortSignal.any([interrupted.signal, limit]);

  const aborted = new Promise<never>((_resolve, reject) => {
    signal.addEventListener("abort", () => {
      reject(new Error(`stopped: ${String(signal.reason)}`));
    });
  });

  let detail = "";

  console.error(`e2e: ${name} (limit ${limitMs / MINUTE_MS} min)`);

  try {
    await Promise.race([work(signal), aborted]);
  } catch (cause) {
    detail = describe(cause);
  }

  const seconds = Math.round((Date.now() - began) / 1000);

  outcomes.push({ name, ok: detail === "", seconds, detail });
  console.error(`e2e: ${name} ${detail === "" ? "passed" : `failed: ${detail}`}`);

  return detail === "";
}

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

async function main(): Promise<boolean> {
  let owner: Owner | undefined;

  console.error(`e2e: run ${target.runId}, target ${values.url ?? `stage ${target.stage ?? ""}`}`);

  if (!values.cleanup) {
    await step("deploy and set up", 25 * MINUTE_MS, async () => {
      owner = await target.deploy();
    });

    if (owner !== undefined) await workflows(owner);
  }

  cleaning = true;

  if (!values.cleanup) await step("ops:check", 5 * MINUTE_MS, () => target.checkOps());

  if (values.keep) {
    const file = join(tmpdir(), `cf-stumble-e2e-${target.runId}-password`);

    writeFileSync(file, password, { mode: 0o600 });
    console.error(`e2e: kept ${owner?.url ?? "the target"}; the owner password is in ${file}`);
  } else {
    await cleanUp();
  }

  return outcomes.every((outcome) => outcome.ok);
}

const passed = await main().catch((cause: unknown) => {
  console.error(cause);

  return false;
});

const minutes = Math.round((Date.now() - startedMs) / MINUTE_MS);

console.error(`\ne2e run ${target.runId}: ${passed ? "PASS" : "FAIL"} in ${minutes} min`);

for (const { ok, name, seconds, detail } of outcomes) {
  console.error(`${ok ? "✓" : "✗"} ${name} (${seconds} s)${ok ? "" : `: ${detail}`}`);
}

process.exitCode = passed ? 0 : 1;
