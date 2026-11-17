import { expect, test } from "vitest";
import type { Generation, GenerationStatus } from "../../src/supervisor/generation-state.js";
import { testHarnessCommit } from "../harness-commit-fixtures.js";
import { label as generationLabel } from "../supervisor/generations/fixtures.js";
import { controlRequest, apiResponse, apiSupervisor as supervisor } from "./helpers.js";

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

const ready = {
  ok: true,
  report: {
    stage: "ready",
    reason: "the startup check passed",
    generation: candidate("ready"),
    effect: "recorded",
  },
} as const;

function preparing(answers: readonly (Error | typeof ready)[]) {
  const asked: number[] = [];

  const stub = (index: number) =>
    supervisor({
      submitGeneration() {
        return Promise.resolve(labeled);
      },
      prepareGeneration(label) {
        asked.push(label);
        const answer = answers[index];

        return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer ?? ready);
      },
    });

  return { asked, stubs: answers.map((_answer, index) => stub(index)) };
}

test("prepares the generation again on a new Supervisor stub when a deploy reset the Supervisor mid-check (deploy 44075948231)", async () => {
  const { asked, stubs } = preparing([new Error(CODE_UPDATE_RESET), ready]);

  const response = await apiResponse(submitRequest(submissionBody()), ...stubs);

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({
    ok: true,
    preparation: { ok: true, report: { stage: "ready" } },
  });
  expect(asked).toEqual([generationLabel(1), generationLabel(1)]);
});

test("answers preparation-failed when the Supervisor is reset again on the second preparation", async () => {
  const { asked, stubs } = preparing([new Error(CODE_UPDATE_RESET), new Error(CODE_UPDATE_RESET)]);

  const response = await apiResponse(submitRequest(submissionBody()), ...stubs);

  expect(response.status).toBe(500);
  await expect(response.json()).resolves.toMatchObject({ error: { code: "preparation-failed" } });
  expect(asked).toHaveLength(2);
});

test("does not prepare again after a failure that is not a code update", async () => {
  const { asked, stubs } = preparing([new Error("storage rejected a row"), ready]);

  const response = await apiResponse(submitRequest(submissionBody()), ...stubs);

  expect(response.status).toBe(500);
  expect(asked).toHaveLength(1);
});
