import { setTimeout as sleep } from "node:timers/promises";
import { execute } from "./process.mts";
import { REPOSITORY_URL, type GitHub } from "./github.mts";
import type { Owner } from "./owner-api.mts";

export type Run = Readonly<{
  id: string;
  owner: Owner;
  github: GitHub;
  password: string;
  signal: AbortSignal;
}>;

export const HARNESS_PROJECT = "harness";

const GIT_IDENTITY = "git -c user.name=cf-stumble-e2e -c user.email=e2e@cf-stumble.invalid";

function check(condition: boolean, failure: string): void {
  if (!condition) throw new Error(failure);
}

async function explained(run: Run, projectId: string, work: () => Promise<void>) {
  try {
    await work();
  } catch (cause) {
    const output = await run.owner.toolOutput(projectId, 3);
    const message = cause instanceof Error ? cause.message : String(cause);

    throw new Error(`${message}\nlast tool output:\n${output}`, { cause });
  }
}

export function markerPath(runId: string, suffix: string): string {
  return `e2e-check/${runId}${suffix}.txt`;
}

function markerText(run: Run, suffix: string): string {
  return `cf-stumble e2e ${run.id}${suffix}`;
}

export async function pageWorkflow(run: Run): Promise<void> {
  const finished = await execute(
    "pnpm",
    ["exec", "playwright", "test", "-c", "tools/e2e/playwright.config.mts"],
    {
      env: {
        ...process.env,
        E2E_RUN_ID: run.id,
        E2E_URL: run.owner.url,
        E2E_OWNER_PASSWORD: run.password,
      },
      echo: true,
    },
  );

  check(finished.code === 0, `the page spec exited ${finished.code}`);
}

export async function productLoop(run: Run, connected: (projectId: string) => void) {
  const branch = `e2e/${run.id}`;
  const path = markerPath(run.id, "");

  const projectId = await run.owner.connect(REPOSITORY_URL);

  connected(projectId);
  await run.owner.send(
    projectId,
    [
      "Make a small change in this repository and publish it on a new branch.",
      "Do these steps in order, one tool call each, and stop at the first failure:",
      `1. Run in the container with the bash tool: git checkout -b ${branch}`,
      `2. Use the write tool to create the file ${path} with exactly this one line: ${markerText(run, "")}`,
      `3. Run in the container with the bash tool: git add ${path} && ${GIT_IDENTITY} commit -m "e2e: ${run.id}"`,
      `4. Run in the container with the bash tool: git push origin ${branch}`,
      "Then reply with the commit id that git printed.",
    ].join("\n"),
  );

  await explained(run, projectId, async () => {
    const settled = await run.owner.waitSettled(projectId, run.signal);

    check(settled.failure === undefined, `the run stopped: ${settled.failure}`);

    const pushed = await run.github.fileAt(path, branch);

    check(
      pushed?.trim() === markerText(run, ""),
      `${path} on ${branch} is ${JSON.stringify(pushed)}`,
    );
  });
}

async function waitForActivation(run: Run, before: number | undefined): Promise<string> {
  for (;;) {
    const { generation } = await run.owner.status();

    if (generation !== null && generation.label !== before) return generation.harnessCommit;

    const { docs } = await run.owner.view(HARNESS_PROJECT);
    const live = docs["pi.live"];

    check(
      live.run !== undefined || docs["pi.inbox"].items.length > 0,
      `the turn ended without a new active generation (${live.runFailure?.reason ?? "no failure"})`,
    );
    await sleep(5_000, undefined, { signal: run.signal });
  }
}

export async function selfModification(run: Run): Promise<void> {
  const path = markerPath(run.id, "-gen");
  const before = (await run.owner.status()).generation?.label;

  await run.owner.send(
    HARNESS_PROJECT,
    [
      "Change your own harness with a marker file, then switch to the generation built from it.",
      "Do these steps in order, one tool call each, and stop at the first failure:",
      `1. Use the write tool to create the file /workspace/harness/${path} with exactly this one line: ${markerText(run, "-gen")}`,
      `2. Run in the container with the bash tool: cd /workspace/harness && git add ${path} && ${GIT_IDENTITY} commit -m "e2e: ${run.id} generation" && git rev-parse HEAD`,
      `3. Run in the container with the bash tool: git -C /workspace/harness push origin HEAD:refs/heads/self-modify/${run.id}-gen`,
      "4. Run with the bash tool: stumble gen prepare <the commit id from step 2>",
      "5. When it reports the generation ready, run with the bash tool the exact stumble gen activate command it printed.",
      "6. If that command came back interrupted, run with the bash tool: stumble gen status",
      "This change is a throwaway for this run: skip the pull request. Then reply with the active generation label.",
    ].join("\n"),
  );

  await sleep(2_000, undefined, { signal: run.signal });

  let commit = "";

  await explained(run, HARNESS_PROJECT, async () => {
    commit = await waitForActivation(run, before);
  });
  const marker = await run.github.fileAt(path, commit);

  check(marker?.trim() === markerText(run, "-gen"), `the active commit ${commit} lacks ${path}`);
  await run.owner.waitSettled(HARNESS_PROJECT, run.signal);

  const seen = (await run.owner.entries(HARNESS_PROJECT)).at(0)?.id ?? 0;

  await run.owner.send(HARNESS_PROJECT, "Reply with the single word continued.");

  const settled = await run.owner.waitSettled(HARNESS_PROJECT, run.signal);

  const answered = (await run.owner.entries(HARNESS_PROJECT)).filter(
    (entry) => entry.id > seen && entry.kind === "pi.assistant",
  );

  check(settled.failure === undefined, `the turn after activation stopped: ${settled.failure}`);
  check(answered.length > 0, "the new generation did not answer the turn after activation");
}
