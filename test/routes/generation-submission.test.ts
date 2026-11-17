import { expect, test } from "vitest";
import type { Generation, GenerationStatus } from "../../src/supervisor/generation-state.js";
import { testHarnessCommit } from "../harness-commit-fixtures.js";
import { label as generationLabel } from "../supervisor/generations/fixtures.js";
import {
  controlRequest,
  apiResponse,
  apiSupervisor as supervisor,
  WORKER_VERSION,
} from "./helpers.js";
import type { StartupCheckResult } from "../../src/supervisor/startup-check/index.js";

const harnessCommit = "0123456789abcdef0123456789abcdef01234567";

function candidate(status: GenerationStatus): Generation {
  return { label: generationLabel(1), harnessCommit: testHarnessCommit(harnessCommit), status };
}

function submitRequest(body: string): Request {
  return controlRequest("/api/generations/submit", body);
}

function submissionBody(commit: string = harnessCommit): string {
  return JSON.stringify({ harnessCommit: commit });
}

const labeled = {
  kind: "candidate-submitted",
  generation: candidate("candidate"),
  epoch: 4,
} as const;

test("returns a failed build step's output tail to the owner", async () => {
  const diagnostics = {
    stdoutTail: "",
    stderrTail: "error TS2322: compiler output",
    truncated: false,
  };

  const response = await apiResponse(
    submitRequest(submissionBody()),
    supervisor({
      submitGeneration() {
        return Promise.resolve(labeled);
      },
      prepareGeneration() {
        return Promise.resolve({
          ok: false,
          problem: {
            code: "build-step-failed",
            harnessCommit,
            step: "build-module-map",
            exitCode: 2,
            diagnostics,
          },
        });
      },
    }),
  );

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({
    preparation: { ok: false, problem: { code: "build-step-failed", diagnostics } },
  });
});

test("reports the recorded label with a preparation failure, without echoing the internal error", async () => {
  const response = await apiResponse(
    submitRequest(submissionBody()),
    supervisor({
      submitGeneration() {
        return Promise.resolve(labeled);
      },
      prepareGeneration() {
        return Promise.reject(new Error("storage rejected a row with account secret sk-live-1"));
      },
    }),
  );

  expect(response.status).toBe(500);
  await expect(response.json()).resolves.toEqual({
    ok: false,
    error: { code: "preparation-failed" },
    recorded: { label: generationLabel(1), harnessCommit },
  });
});

const CODE_UPDATE_RESET = "Durable Object reset because its code was updated.";

const ready: StartupCheckResult = {
  ok: true,
  report: {
    stage: "ready",
    reason: "the startup check passed",
    generation: candidate("ready"),
    effect: "recorded",
  },
};

const unavailable: StartupCheckResult = {
  ok: false,
  problem: { code: "build-workspace-unavailable", harnessCommit },
};

type Answer = Error | StartupCheckResult;

function stub(answer: Answer, version: string, asked: number[]) {
  return supervisor({
    submitGeneration() {
      return Promise.resolve(labeled);
    },
    prepareGeneration(label) {
      asked.push(label);

      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
    scriptVersion: () => Promise.resolve(version),
  });
}

async function submitted(first: Answer, second: Answer, secondVersion: string) {
  const asked: number[] = [];

  const response = await apiResponse(
    submitRequest(submissionBody()),
    stub(first, WORKER_VERSION, asked),
    stub(second, secondVersion, asked),
  );

  return { asked, response };
}

const NEW_VERSION = "version-deployed-during-the-request";

test("prepares the generation again when the reset Supervisor already runs the Worker's version by the time of the check (deploy 44075948231, deploy 44128047200)", async () => {
  const { asked, response } = await submitted(new Error(CODE_UPDATE_RESET), ready, WORKER_VERSION);

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({
    preparation: { ok: true, report: { stage: "ready" } },
  });
  expect(asked).toEqual([generationLabel(1), generationLabel(1)]);
});

test("prepares again when the Supervisor that a deploy was resetting answered with a workspace problem (forced race on a throwaway stage)", async () => {
  const { asked, response } = await submitted(
    { ok: true, report: { ...ready.report, stage: "mount-failed" } },
    ready,
    NEW_VERSION,
  );

  await expect(response.json()).resolves.toMatchObject({ preparation: { ok: true } });
  expect(asked).toHaveLength(2);

  const second = await submitted(unavailable, ready, NEW_VERSION);

  await expect(second.response.json()).resolves.toMatchObject({
    preparation: { ok: true, report: { stage: "ready" } },
  });
});

test("answers with the second preparation when a deploy reset the Supervisor and the check still fails", async () => {
  const { asked, response } = await submitted(
    new Error(CODE_UPDATE_RESET),
    unavailable,
    NEW_VERSION,
  );

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({
    preparation: { ok: false, problem: { code: "build-workspace-unavailable" } },
  });
  expect(asked).toHaveLength(2);
});

test("does not prepare again when the Supervisor runs the version that served the request", async () => {
  for (const failing of [new Error("storage rejected a row"), unavailable]) {
    const { asked } = await submitted(failing, ready, WORKER_VERSION);

    expect(asked).toHaveLength(1);
  }
});
