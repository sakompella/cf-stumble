import * as Effect from "effect/Effect";
import { releaseOwner, type ApiClient } from "../../tools/release-generation/owner.mts";
import { releaseGeneration, type ReleaseDeps } from "../../tools/release-generation/release.mts";
import { routeApiRequest } from "../../src/routes/index.js";
import type { Generation, Submission } from "../../src/supervisor/generation-state.js";
import { buildModuleMap } from "../../src/supervisor/artifacts/build.js";
import type { StartupCheckResult } from "../../src/supervisor/startup-check/index.js";
import { FakeBuildHost } from "../supervisor/artifacts/scripted-build-host.js";
import { apiSupervisor, controlRequest } from "../routes/helpers.js";
import { label as generationLabel, testHarnessCommit } from "../supervisor/generations/fixtures.js";

export const MAIN = "b".repeat(40);

export const ATTEMPT_MS = 70_000;

export const STORAGE_STARTUP = new Error(
  "Internal error while starting up Durable Object storage caused object to be reset; reference = b8sd9000hraaunrso5ttv63p",
);

export class ProvisionHost extends FakeBuildHost {
  provisions = 0;
  readonly rejected: number;

  constructor(rejected: number) {
    super();
    this.rejected = rejected;
  }

  override build(request: Parameters<FakeBuildHost["build"]>[0]) {
    if (request.step !== "provision") return super.build(request);

    this.provisions += 1;
    this.requests.push(request.step);

    return this.provisions <= this.rejected
      ? Promise.reject(STORAGE_STARTUP)
      : Promise.resolve({ ok: true as const, output: { stdout: "", stderr: "", exitCode: 0 } });
  }
}

export type Run = Readonly<{
  summary: Promise<string>;
  events: string[];
  labels: Set<number>;
  waits: number[];
  clock: () => number;
}>;

type World = {
  readonly host: FakeBuildHost;
  readonly events: string[];
  readonly labels: Set<number>;
  recordedLabel: number | undefined;
  rejectedSubmits: number;
  clock: number;
};

function generation(world: World, status: Generation["status"]): Generation {
  return {
    label: generationLabel(world.recordedLabel ?? 0),
    harnessCommit: testHarnessCommit(MAIN),
    status,
  };
}

function submitGeneration(world: World): Promise<Submission> {
  world.recordedLabel ??= 51;
  world.labels.add(world.recordedLabel);

  if (world.rejectedSubmits > 0) {
    world.rejectedSubmits -= 1;

    return Promise.reject(new Error("the object was reset after the label committed"));
  }

  return Promise.resolve({
    kind: "candidate-submitted",
    generation: generation(world, "candidate"),
    epoch: 1,
  });
}

function prepareGeneration(world: World): Promise<StartupCheckResult> {
  world.events.push("prepare");
  world.clock += ATTEMPT_MS;

  const commit = testHarnessCommit(MAIN);

  return Effect.runPromise(
    buildModuleMap(() => world.host, commit).pipe(
      Effect.match({
        onFailure: (problem): StartupCheckResult => ({ ok: false, problem }),
        onSuccess: (): StartupCheckResult => {
          world.events.push("ready");

          return {
            ok: true,
            report: {
              stage: "ready",
              reason: "the startup check passed",
              generation: generation(world, "ready"),
              effect: "recorded",
            },
          };
        },
      }),
    ),
  );
}

function supervisorOver(world: World) {
  return apiSupervisor({
    submitGeneration: () => submitGeneration(world),
    prepareGeneration: () => prepareGeneration(world),
    controlGeneration() {
      world.events.push("activate");

      const outcome = {
        kind: "activated",
        generation: generation(world, "ready"),
        epoch: 2,
        effect: "activated",
      } as const;

      return Promise.resolve({ ok: true, outcome });
    },
  });
}

function routedClient(stub: ReturnType<typeof supervisorOver>): ApiClient {
  const routed = async (request: Request) => {
    const response = await Effect.runPromise(routeApiRequest(request, stub));

    return { status: response.status, text: await response.text() };
  };

  return {
    get: (path) => routed(new Request(`https://cf-stumble.test${path}`)),
    post: (path, body) => routed(controlRequest(path, JSON.stringify(body))),
  };
}

export function release(host: FakeBuildHost, rejectedSubmits = 0): Run {
  const world: World = {
    host,
    events: [],
    labels: new Set(),
    recordedLabel: undefined,
    rejectedSubmits,
    clock: 0,
  };

  const waits: number[] = [];

  const deps: ReleaseDeps = {
    owner: releaseOwner(routedClient(supervisorOver(world))),
    force: false,
    facetChangedSince: () => Promise.resolve(true),
    wait: (ms) => {
      waits.push(ms);
      world.clock += ms;

      return Promise.resolve();
    },
    now: () => world.clock,
    report: () => {},
  };

  return {
    summary: releaseGeneration(MAIN, deps),
    events: world.events,
    labels: world.labels,
    waits,
    clock: () => world.clock,
  };
}
