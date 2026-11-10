import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { Owner } from "../owner-api.mts";
import { MINUTE_MS, Steps } from "../steps.mts";
import { Target } from "../target.mts";
import type { Finding, Fuzzer } from "./context.mts";

const AREAS = new Map<string, () => Promise<Fuzzer>>([
  ["http", async () => (await import("./http.mts")).fuzz],
  ["page", async () => (await import("./page.mts")).fuzz],
]);

const { values } = parseArgs({
  options: {
    area: { type: "string" },
    seed: { type: "string" },
    minutes: { type: "string", default: "30" },
    stage: { type: "string" },
    "run-id": { type: "string" },
    keep: { type: "boolean", default: false },
    cleanup: { type: "boolean", default: false },
  },
});

const names = values.area === undefined ? [...AREAS.keys()] : values.area.split(",");

for (const name of names) {
  if (!AREAS.has(name)) {
    throw new Error(`unknown area ${name}; known: ${[...AREAS.keys()].join(", ")}`);
  }
}

const seed = values.seed === undefined ? randomBytes(4).readUInt32BE() : Number(values.seed);

const minutes = Number(values.minutes);

const steps = new Steps();

const password = process.env["E2E_OWNER_PASSWORD"] ?? randomBytes(24).toString("base64url");

const target = new Target({
  runId: values["run-id"] ?? randomBytes(4).toString("hex"),
  url: undefined,
  stage: values.stage,
  prefix: `fz${names.length === 1 ? names[0] : "all"}`,
  password,
  env: process.env,
});

const secrets = [
  password,
  Buffer.from(`aditya:${password}`).toString("base64"),
  process.env["GH_TOKEN"] ?? "",
  process.env["CLOUDFLARE_API_TOKEN"] ?? "",
].filter((secret) => secret.length >= 8);

const findings: Finding[] = [];

function summary(): string {
  return findings
    .map(
      (finding) =>
        `[${finding.area}] ${finding.oracle}: ${finding.detail}\n  reproduce: ${finding.reproduction}`,
    )
    .join("\n");
}

async function fuzz(owner: Owner): Promise<void> {
  for (const [index, name] of names.entries()) {
    const registered = AREAS.get(name);

    if (registered === undefined) continue;

    const area = await registered();
    const slice = minutes / names.length;
    const deadlineMs = Date.now() + slice * MINUTE_MS;

    console.error(`fuzz: ${name} seed ${seed + index} for ${slice} min`);

    await steps.run(`fuzz ${name}`, (slice + 5) * MINUTE_MS, async (signal) => {
      findings.push(
        ...(await area({
          area: name,
          seed: seed + index,
          deadlineMs,
          signal,
          owner,
          password,
          target,
          secrets,
          log: (line) => {
            console.error(`fuzz ${name}: ${line}`);
          },
        })),
      );
    });
  }

  await steps.run("oracles held", MINUTE_MS, () => {
    if (findings.length > 0) {
      return Promise.reject(new Error(`${findings.length} findings\n${summary()}`));
    }

    return Promise.resolve();
  });
}

async function main(): Promise<void> {
  console.error(`fuzz: run ${target.runId}, stage ${target.stage ?? ""}, seed ${seed}`);

  if (!values.cleanup) {
    let owner: Owner | undefined;

    await steps.run("deploy and set up", 25 * MINUTE_MS, async () => {
      owner = await target.deploy();
    });

    if (owner !== undefined) await fuzz(owner);
  }

  steps.startCleanup();

  if (!values.cleanup) await steps.run("ops:check", 5 * MINUTE_MS, () => target.checkOps());

  if (values.keep) {
    const file = join(tmpdir(), `cf-stumble-e2e-${target.runId}-password`);

    writeFileSync(file, password, { mode: 0o600 });
    console.error(`fuzz: kept stage ${target.stage ?? ""}; the owner password is in ${file}`);

    return;
  }

  await steps.run("delete branches", 2 * MINUTE_MS, () => target.deleteBranches());

  if (target.fresh) {
    await steps.run("destroy the stage", 15 * MINUTE_MS, () => target.destroy());
  } else {
    await steps.run("restore the target", 2 * MINUTE_MS, () => target.restore());
  }
}

await main().catch((cause: unknown) => {
  console.error(cause);
});

console.error(`fuzz seed ${seed}${findings.length > 0 ? `\n${summary()}` : ""}`);

process.exitCode = steps.report(`fuzz run ${target.runId}`) ? 0 : 1;
