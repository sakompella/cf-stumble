import { setTimeout as sleep } from "node:timers/promises";
import { control, readStatus, submit, type Ledger } from "./lifecycle-actions.mts";
import { pollUntil, type Probe } from "./lifecycle-probe.mts";
import type { Rng } from "./lifecycle-rng.mts";

export const HARNESS = "harness";

export const AUX_REPOSITORY = "https://github.com/octocat/Hello-World";

const SETTLE_LIMIT_MS = 240_000;

const ABORT_LIMIT_MS = 60_000;

export const PROMPTS = {
  short: "Reply with the single word ok. Do not use any tool.",
  long: "Run this with the bash tool and wait for it to finish: sleep 40. Then reply with the single word done.",
} as const;

export type Disturbance =
  | "none"
  | "abort"
  | "abort-twice"
  | "fresh"
  | "reset"
  | "disconnect-same"
  | "disconnect-aux"
  | "connect-aux"
  | "activate"
  | "submit";

export type TurnPlan = Readonly<{
  project: string;
  prompt: keyof typeof PROMPTS;
  disturbance: Disturbance;
  delayMs: number;
}>;

type Settled = Readonly<{ ended: boolean; failure: string | undefined }>;

async function liveState(probe: Probe, project: string): Promise<Settled | undefined> {
  try {
    const { docs } = await probe.owner.view(project);
    const live = docs["pi.live"];
    const busy = live.run !== undefined || docs["pi.inbox"].items.length > 0;

    return { ended: !busy, failure: live.runFailure?.reason };
  } catch (cause) {
    probe.note(
      `view of ${project} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    );

    return undefined;
  }
}

async function settle(probe: Probe, project: string, limitMs: number, signal: AbortSignal) {
  let last: Settled | undefined;

  const done = await pollUntil(limitMs, signal, async () => {
    last = await liveState(probe, project);

    return last?.ended === true;
  });

  return { done, failure: last?.failure };
}

async function disturb(
  probe: Probe,
  ledger: Ledger,
  rng: Rng,
  plan: TurnPlan,
  aux: { id: string | undefined },
) {
  const { project } = plan;

  switch (plan.disturbance) {
    case "none":
      return;
    case "abort":
      await probe.http("POST", `/api/projects/${project}/abort`);

      return;
    case "abort-twice":
      await Promise.all([
        probe.http("POST", `/api/projects/${project}/abort`),
        probe.http("POST", `/api/projects/${project}/abort`),
      ]);

      return;
    case "fresh":
      await probe.http("POST", `/api/projects/${project}/thread/fresh`);

      return;
    case "reset":
      await probe.http("POST", "/api/workspace/reset");

      return;
    case "disconnect-same":
      await probe.http("POST", `/api/projects/${project}/disconnect`);

      return;
    case "disconnect-aux":
      if (aux.id !== undefined) await probe.http("POST", `/api/projects/${aux.id}/disconnect`);

      return;
    case "connect-aux":
      await connectAux(probe, aux);

      return;
    case "activate": {
      const ready = [...ledger.commits.values()].filter((known) => known.ready);

      if (ready.length > 0)
        await control(probe, ledger, rng, "activate", rng.pick(ready).label, "fresh");

      return;
    }

    case "submit": {
      const commit = [...ledger.commits.keys()][0];

      if (commit !== undefined) await submit(probe, ledger, commit);
    }
  }
}

async function connectAux(probe: Probe, aux: { id: string | undefined }) {
  const reply = await probe.http("POST", "/api/projects/connect", {
    repositoryUrl: AUX_REPOSITORY,
  });

  const id = reply.doc.project?.id;

  if (id !== undefined) aux.id = id;
}

export async function runTurn(
  probe: Probe,
  ledger: Ledger,
  rng: Rng,
  plan: TurnPlan,
  aux: { id: string | undefined },
  signal: AbortSignal,
): Promise<void> {
  const tag = `turn ${plan.project}/${plan.prompt}/${plan.disturbance}@${plan.delayMs}`;

  probe.note(`== ${tag}`);

  const sent = await probe.http("POST", `/api/projects/${plan.project}/messages`, {
    content: PROMPTS[plan.prompt],
    requestId: crypto.randomUUID(),
  });

  if (sent.status !== 202) {
    if (sent.status >= 500 || (sent.status !== 404 && sent.status !== 409 && sent.status !== 503)) {
      probe.violation(`${tag}: message answered ${sent.status}`);
    }

    return;
  }

  await sleep(plan.delayMs, undefined, { signal });

  const disturbedAt = Date.now();

  await disturb(probe, ledger, rng, plan, aux);

  const stopping = plan.disturbance.startsWith("abort") || plan.disturbance === "fresh";

  const result = await settle(
    probe,
    plan.project,
    stopping ? ABORT_LIMIT_MS : SETTLE_LIMIT_MS,
    signal,
  );

  probe.note(
    `settled ${String(result.done)} after ${Date.now() - disturbedAt}ms failure ${String(result.failure)}`,
  );
  probe.count(`turn ${plan.disturbance} ${String(result.failure)}`);

  if (!result.done) {
    probe.violation(`${tag}: the run did not settle`);
    await probe.http("POST", `/api/projects/${plan.project}/abort`);
    await settle(probe, plan.project, ABORT_LIMIT_MS, signal);
  }

  await readStatus(probe, ledger);
}
