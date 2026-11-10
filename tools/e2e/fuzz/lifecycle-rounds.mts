import { setTimeout as sleep } from "node:timers/promises";
import {
  control,
  hostileControl,
  hostileSubmit,
  readStatus,
  submit,
  type Ledger,
} from "./lifecycle-actions.mts";
import type { Probe } from "./lifecycle-probe.mts";
import type { Rng } from "./lifecycle-rng.mts";
import {
  AUX_REPOSITORY,
  HARNESS,
  runTurn,
  type Disturbance,
  type TurnPlan,
} from "./lifecycle-turns.mts";

export const MAX_TURNS = 10;

const DISTURBANCES: readonly (readonly [Disturbance, number])[] = [
  ["none", 1],
  ["abort", 4],
  ["abort-twice", 1],
  ["fresh", 2],
  ["reset", 2],
  ["disconnect-same", 1],
  ["disconnect-aux", 1],
  ["connect-aux", 1],
  ["activate", 2],
  ["submit", 1],
];

const BAD_REPOSITORIES = [
  "",
  "not a url",
  "file:///etc/passwd",
  "ssh://git@github.com/sakompella/cf-stumble.git",
  "https://github.com/sakompella/does-not-exist-fz",
  "https://example.com/x/y",
  "https://github.com/../..",
  "https://user:pw@github.com/octocat/Hello-World",
  "http://github.com/octocat/Hello-World",
];

export type Aux = { id: string | undefined };

export function turnPlan(rng: Rng, aux: Aux): TurnPlan {
  const disturbance = rng.weighted(DISTURBANCES);
  const project = disturbance === "disconnect-same" && aux.id !== undefined ? aux.id : HARNESS;

  return {
    project,
    prompt: disturbance === "none" ? "short" : "long",
    disturbance,
    delayMs: rng.weighted([
      [0, 2],
      [rng.between(100, 1500), 3],
      [rng.between(2000, 9000), 3],
      [rng.between(10_000, 25_000), 2],
    ]),
  };
}

async function noise(probe: Probe, ledger: Ledger, rng: Rng, commits: readonly string[]) {
  const action = rng.weighted([
    ["submit", 3],
    ["activate", 3],
    ["rollback", 2],
    ["hostile", 2],
    ["status", 2],
  ] as const);

  const labels = [...ledger.commits.values()].map((known) => known.label);
  const label = labels.length > 0 && rng.chance(0.85) ? rng.pick(labels) : rng.int(40);

  const mode = rng.weighted([
    ["fresh", 5],
    ["stale", 3],
    ["future", 1],
  ] as const);

  switch (action) {
    case "submit":
      await submit(probe, ledger, rng.chance(0.2) ? rng.hex(40) : rng.pick(commits));

      return;
    case "activate":
    case "rollback":
      await control(probe, ledger, rng, action, label, mode);

      return;
    case "hostile":
      await (rng.chance(0.5) ? hostileControl(probe, rng) : hostileSubmit(probe, rng));

      return;
    case "status":
      await readStatus(probe, ledger);
  }
}

export async function burst(
  probe: Probe,
  ledger: Ledger,
  rng: Rng,
  commits: readonly string[],
  signal: AbortSignal,
) {
  const width = rng.between(1, 4);

  const jobs = Array.from({ length: width }, async () => {
    await sleep(rng.int(1500), undefined, { signal });
    await noise(probe, ledger, rng, commits);
  });

  await Promise.all(jobs);
}

export async function sameCommitStorm(
  probe: Probe,
  ledger: Ledger,
  rng: Rng,
  commits: readonly string[],
) {
  const commit = rng.pick(commits);
  const copies = rng.between(2, 4);

  await Promise.all(Array.from({ length: copies }, () => submit(probe, ledger, commit)));
}

export async function connectFuzz(probe: Probe, rng: Rng, aux: Aux) {
  if (rng.chance(0.5)) {
    const reply = await probe.http("POST", "/api/projects/connect", {
      repositoryUrl: rng.pick(BAD_REPOSITORIES),
    });

    if (reply.status === 200)
      probe.violation(`a bad repository connected: ${reply.text.slice(0, 160)}`);

    return;
  }

  if (aux.id === undefined) {
    const reply = await probe.http("POST", "/api/projects/connect", {
      repositoryUrl: AUX_REPOSITORY,
    });

    aux.id = reply.doc.project?.id ?? aux.id;

    return;
  }

  const reply = await probe.http("POST", `/api/projects/${aux.id}/disconnect`);

  if (reply.status === 200) aux.id = undefined;
}

export async function checkProjectsConsistent(probe: Probe, aux: Aux) {
  const reply = await probe.http("GET", "/api/projects");

  if (reply.status !== 200) return;

  const projects = reply.doc.projects ?? [];

  if (!projects.some((project) => project.id === HARNESS))
    probe.violation("the harness project vanished from the catalog");

  if (aux.id !== undefined && !projects.some((project) => project.id === aux.id)) {
    probe.note(`aux project ${aux.id} is no longer listed`);
    aux.id = undefined;
  }
}

export type RoundContext = Readonly<{
  probe: Probe;
  ledger: Ledger;
  rng: Rng;
  commits: readonly string[];
  aux: Aux;
  signal: AbortSignal;
}>;

export async function playRound(kind: string, context: RoundContext): Promise<void> {
  const { probe, ledger, rng, commits, aux, signal } = context;

  switch (kind) {
    case "turn": {
      const plan = turnPlan(rng, aux);

      const background = Promise.all(
        Array.from({ length: rng.between(0, 2) }, () => burst(probe, ledger, rng, commits, signal)),
      );

      await Promise.all([runTurn(probe, ledger, rng, plan, aux, signal), background]);

      return;
    }

    case "burst":
      await burst(probe, ledger, rng, commits, signal);

      return;
    case "same-commit":
      await sameCommitStorm(probe, ledger, rng, commits);

      return;
    case "connect":
      await connectFuzz(probe, rng, aux);

      return;
    case "idle-reset": {
      const reply = await probe.http("POST", "/api/workspace/reset");

      if (reply.status !== 200 && reply.status !== 409)
        probe.violation(`idle reset answered ${reply.status}`);

      return;
    }

    default:
      await checkProjectsConsistent(probe, aux);
  }
}
