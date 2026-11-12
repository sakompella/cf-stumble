import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import * as Schema from "effect/Schema";
import type { Owner } from "../owner-api.mts";
import { execute, succeed } from "../process.mts";
import { HARNESS_REMOTE } from "../github.mts";

const HARNESS_PROJECT = "harness";

const MODEL_PATH = "src/facet/generation-1/scripted-model.ts";

const FACET_PATH = "src/facet/generation-1/main-facet.ts";

const IMPORT_AFTER = 'import { ROUTE_AGENT } from "./route-provider.js";\n';

const RESULTS_PREFIX = "fuzz-results ";

export type Step = Readonly<{ tool: string; args: Readonly<Record<string, string>> }>;

function git(args: readonly string[], env: NodeJS.ProcessEnv = process.env, input?: string) {
  return succeed("git", args, input === undefined ? { env } : { env, input });
}

async function blob(text: string): Promise<string> {
  return (await git(["hash-object", "-w", "--stdin"], process.env, text)).trim();
}

function patchedFacet(source: string): string {
  const call = "        model,\n";

  if (!source.includes(call) || !source.includes(IMPORT_AFTER)) {
    throw new Error(`${FACET_PATH} no longer matches the patch`);
  }

  return source
    .replace(IMPORT_AFTER, `${IMPORT_AFTER}import { scriptedModel } from "./scripted-model.js";\n`)
    .replace(call, "        model: scriptedModel(model),\n");
}

export async function scriptedCommit(): Promise<string> {
  const head = (await git(["rev-parse", "HEAD"])).trim();
  const index = `${(await git(["rev-parse", "--git-dir"])).trim()}/fuzz-index-${process.pid}`;
  const env = { ...process.env, GIT_INDEX_FILE: index };
  const facet = patchedFacet(await git(["show", `HEAD:${FACET_PATH}`]));
  const model = readFileSync(new URL("scripted-model.ts", import.meta.url), "utf8");

  await git(["read-tree", "HEAD"], env);

  for (const [path, text] of [
    [FACET_PATH, facet],
    [MODEL_PATH, model],
  ] as const) {
    await git(["update-index", "--add", "--cacheinfo", `100644,${await blob(text)},${path}`], env);
  }

  const tree = (await git(["write-tree"], env)).trim();
  const identity = ["-c", "user.name=cf-stumble-fuzz", "-c", "user.email=fuzz@cf-stumble.invalid"];

  await execute("rm", ["-f", index]);

  return (
    await git([...identity, "commit-tree", tree, "-p", head, "-m", "fuzz: scripted model"])
  ).trim();
}

export async function pushBranch(
  sha: string,
  branch: string,
  token: string,
  remote: string = HARNESS_REMOTE,
): Promise<void> {
  const header = `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;

  await git(["push", remote, `${sha}:refs/heads/${branch}`], {
    ...process.env,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: header,
    GIT_TERMINAL_PROMPT: "0",
  });
}

function bootstrapMessage(branch: string, sha: string): string {
  return [
    "Switch to a prepared generation.",
    "Do these steps in order, one tool call each, and stop at the first failure:",
    `1. Run with the bash tool: git -C /workspace/harness fetch origin ${branch}`,
    `2. Run with the bash tool: stumble gen prepare ${sha}`,
    "3. When it reports the generation ready, run with the bash tool the exact stumble gen activate command it printed.",
    "4. If that command came back interrupted, run with the bash tool: stumble gen status",
    "Then reply with the active generation label.",
  ].join("\n");
}

async function activated(owner: Owner, sha: string, signal: AbortSignal): Promise<boolean> {
  for (;;) {
    if ((await owner.status()).generation?.harnessCommit === sha) return true;

    const { docs } = await owner.view(HARNESS_PROJECT);

    if (docs["pi.live"].run === undefined && docs["pi.inbox"].items.length === 0) return false;

    await sleep(5_000, undefined, { signal });
  }
}

export async function installScriptedGeneration(
  owner: Owner,
  sha: string,
  branch: string,
  signal: AbortSignal,
): Promise<void> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await owner.send(HARNESS_PROJECT, bootstrapMessage(branch, sha));
    await sleep(2_000, undefined, { signal });

    if (await activated(owner, sha, signal)) return;

    console.error(`fuzz: the model did not activate ${sha} (attempt ${attempt})`);
  }

  throw new Error(`the scripted generation ${sha} was not activated`);
}

const Text = Schema.Tuple([
  Schema.Struct({
    content: Schema.Tuple([Schema.Struct({ text: Schema.String })]),
  }),
]);

function resultsOf(model: readonly unknown[]): readonly string[] {
  const { text } = Schema.decodeUnknownSync(Text)(model)[0].content[0];

  if (!text.startsWith(RESULTS_PREFIX))
    throw new Error(`the scripted turn answered: ${text.slice(0, 300)}`);

  return Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.String)))(
    text.slice(RESULTS_PREFIX.length),
  );
}

export async function runSteps(
  owner: Owner,
  steps: readonly Step[],
  signal: AbortSignal,
): Promise<readonly string[]> {
  await owner.post(`/api/projects/${HARNESS_PROJECT}/thread/fresh`);
  await owner.send(HARNESS_PROJECT, `fuzz-steps ${JSON.stringify(steps)}`);

  const settled = await owner.waitSettled(HARNESS_PROJECT, signal);

  if (settled.failure !== undefined)
    throw new Error(`the scripted turn stopped: ${settled.failure}`);

  const assistant = (await owner.entries(HARNESS_PROJECT)).find(
    (entry) => entry.kind === "pi.assistant",
  );

  if (assistant === undefined) throw new Error("the scripted turn left no answer");

  return resultsOf(assistant.model);
}
