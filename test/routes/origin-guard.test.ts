import { expect, test } from "vitest";
import { parseHarnessCommit } from "../../src/harness-commit.js";
import { routeOwnerApiRequest } from "../../src/routes/index.js";
import { emptyThread, serializedThread } from "../../src/supervisor/threads/index.js";
import { parseGenerationLabel } from "../../src/supervisor/generations/index.js";
import { sampleProjectOne } from "../project-fixtures.js";
import { ownerApiSupervisor, ownerScope } from "./helpers.js";

const ORIGIN = "https://cf-stumble.test";

const FOREIGN_ORIGIN = "https://evil.example";

const HARNESS_COMMIT = "f53a0e1c1bdbe213ab700a84b1db23615cc24b02";

type Mutation = Readonly<{
  name: string;
  path: string;
  body: Readonly<Record<string, string | number>>;
  operation:
    | "submit"
    | "activate"
    | "rollback"
    | "fresh"
    | "turn"
    | "connect"
    | "authorize"
    | "complete"
    | "reset";
}>;

const mutations: readonly Mutation[] = [
  {
    name: "generation submission",
    path: "/api/generations/submit",
    body: { harnessCommit: HARNESS_COMMIT },
    operation: "submit",
  },
  {
    name: "generation activation",
    path: "/api/generations/activate",
    body: { observedEpoch: 0, label: 0 },
    operation: "activate",
  },
  {
    name: "generation rollback",
    path: "/api/generations/rollback",
    body: { observedEpoch: 0, label: 0 },
    operation: "rollback",
  },
  {
    name: "fresh project thread",
    path: `/api/projects/${sampleProjectOne.id}/thread/fresh`,
    body: {},
    operation: "fresh",
  },
  {
    name: "project turn",
    path: `/api/projects/${sampleProjectOne.id}/turn`,
    body: { prompt: "read the file" },
    operation: "turn",
  },
  {
    name: "project connection",
    path: "/api/projects/connect",
    body: { repositoryUrl: sampleProjectOne.repositoryUrl },
    operation: "connect",
  },
  {
    name: "GitHub authorization",
    path: "/api/github/authorization",
    body: {},
    operation: "authorize",
  },
  {
    name: "GitHub authorization completion",
    path: "/api/github/authorization/complete",
    body: {},
    operation: "complete",
  },
  {
    name: "workspace reset",
    path: "/api/workspace/reset",
    body: {},
    operation: "reset",
  },
];

const origins: readonly Readonly<{
  name: string;
  value: string | undefined;
  status: number;
  calls: number;
}>[] = [
  { name: "foreign Origin", value: FOREIGN_ORIGIN, status: 403, calls: 0 },
  { name: "missing Origin", value: undefined, status: 403, calls: 0 },
  { name: 'Origin "null"', value: "null", status: 403, calls: 0 },
  { name: "same-origin Origin", value: ORIGIN, status: 200, calls: 1 },
];

function requestFor(mutation: Mutation, origin: string | undefined): Request {
  const headers = new Headers({ "content-type": "application/json" });

  if (origin !== undefined) {
    headers.set("origin", origin);
  }

  return new Request(`${ORIGIN}${mutation.path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(mutation.body),
  });
}

// oxlint-disable-next-line eslint/max-lines-per-function
function successfulSupervisor(operation: Mutation["operation"], calls: { value: number }) {
  const label = parseGenerationLabel(0);
  const commit = parseHarnessCommit(HARNESS_COMMIT);

  if (label === undefined || commit === undefined) {
    throw new Error("test fixtures must contain valid generation values");
  }

  const generation = { label, harnessCommit: commit, status: "ready" as const };
  const thread = serializedThread(emptyThread(sampleProjectOne.id));

  switch (operation) {
    case "submit":
      return ownerApiSupervisor({
        controlGeneration: () => {
          calls.value += 1;

          return Promise.resolve({
            ok: true,
            outcome: { kind: "candidate-submitted", generation, epoch: 0 },
          });
        },
        prepareGeneration: () =>
          Promise.resolve({
            ok: true,
            report: { stage: "ready", reason: "test", status: 200, generation, effect: "recorded" },
          }),
      });
    case "activate":
      return ownerApiSupervisor({
        controlGeneration: () => {
          calls.value += 1;

          return Promise.resolve({
            ok: true,
            outcome: { kind: "activated", generation, epoch: 1, effect: "activated" },
          });
        },
      });
    case "rollback":
      return ownerApiSupervisor({
        controlGeneration: () => {
          calls.value += 1;

          return Promise.resolve({
            ok: true,
            outcome: { kind: "rolled-back", generation, epoch: 1, effect: "activated" },
          });
        },
      });
    case "fresh":
      return ownerApiSupervisor({
        startFreshProjectThread: () => {
          calls.value += 1;

          return Promise.resolve({ ok: true, thread });
        },
      });
    case "turn":
      return ownerApiSupervisor({
        runProjectTurn: () => {
          calls.value += 1;

          return Promise.resolve({
            ok: true,
            frames: new ReadableStream<Uint8Array>({
              start(controller) {
                controller.close();
              },
            }),
          });
        },
      });
    case "connect":
      return ownerApiSupervisor({
        connectProject: () => {
          calls.value += 1;

          return Promise.resolve({
            ok: true,
            alreadyConnected: false,
            project: sampleProjectOne,
            github: { state: "disconnected" },
          });
        },
      });
    case "authorize":
      return ownerApiSupervisor({
        startGitHubAuthorization: () => {
          calls.value += 1;

          return Promise.resolve({
            ok: true,
            status: {
              state: "awaiting-authorization",
              verificationUri: "https://github.com/login/device",
              userCode: "WDJB-MJHT",
              expiresAt: 1,
              intervalSeconds: 5,
            },
          });
        },
      });
    case "complete":
      return ownerApiSupervisor({
        completeGitHubAuthorization: () => {
          calls.value += 1;

          return Promise.resolve({ ok: true, status: { state: "disconnected" } });
        },
      });
    case "reset":
      return ownerApiSupervisor({
        resetWorkspace: () => {
          calls.value += 1;

          return Promise.resolve({ ok: true, reset: "workspace" });
        },
      });
    default: {
      const exhaustive: never = operation;
      throw new Error(`unexpected mutation operation: ${String(exhaustive)}`);
    }
  }
}

test.each(mutations.flatMap((mutation) => origins.map((origin) => [mutation, origin] as const)))(
  "requires an exact, present Origin for %s (%s)",
  async (mutation, origin) => {
    const calls = { value: 0 };

    const response = await routeOwnerApiRequest(
      requestFor(mutation, origin.value),
      successfulSupervisor(mutation.operation, calls),
      ownerScope,
    );

    expect(response.status).toBe(origin.status);
    expect(calls.value).toBe(origin.calls);

    if (origin.status === 403) {
      await expect(response.json()).resolves.toEqual({
        ok: false,
        error: { code: "cross-origin-request" },
      });
    }
  },
);
