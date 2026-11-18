import { expect, test } from "vitest";
import { capturedEvents, everythingLogged } from "../log-capture.js";
import type { Generation, GenerationStatus } from "../../src/supervisor/generation-state.js";
import { testHarnessCommit } from "../harness-commit-fixtures.js";
import { label as generationLabel } from "../supervisor/generations/fixtures.js";
import { controlRequest, apiResponse, apiSupervisor as supervisor } from "./helpers.js";
import { CODE_UPDATE_RESET } from "../platform-reset.js";

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

test("answers that the platform interrupted the preparation, with the recorded label and without echoing the internal error", async () => {
  const unmarked = new Error(
    "storage rejected a row with account secret ghp_cfstumbleFAKEtoken0123456789abcd",
  );

  for (const failure of [unmarked, CODE_UPDATE_RESET]) {
    const asked: number[] = [];
    capturedEvents();

    const response = await apiResponse(
      submitRequest(submissionBody()),
      supervisor({
        submitGeneration() {
          return Promise.resolve(labeled);
        },
        prepareGeneration(label) {
          asked.push(label);

          return Promise.reject(failure);
        },
      }),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: { code: "infrastructure-interrupted" },
      recorded: { label: generationLabel(1), harnessCommit },
    });
    expect(asked, "the Worker leaves the repeat to its caller").toEqual([generationLabel(1)]);

    const logged = everythingLogged();

    expect(logged).not.toContain("ghp_cfstumbleFAKEtoken");
    expect(logged).toContain(failure === unmarked ? "retryable=absent" : "retryable=true");
    expect(logged).toContain("overloaded=absent");
  }
});

test("answers that the platform interrupted the submit when the Supervisor rejects it", async () => {
  capturedEvents();

  const response = await apiResponse(
    submitRequest(submissionBody()),
    supervisor({
      submitGeneration() {
        return Promise.reject(new Error("Internal error in Durable Object storage"));
      },
    }),
  );

  expect(response.status).toBe(503);
  await expect(response.json()).resolves.toEqual({
    ok: false,
    error: { code: "infrastructure-interrupted" },
  });
  expect(everythingLogged()).toContain("Internal error in Durable Object storage");
});

test("answers a build problem as the preparation, not as an interruption", async () => {
  const response = await apiResponse(
    submitRequest(submissionBody()),
    supervisor({
      submitGeneration() {
        return Promise.resolve(labeled);
      },
      prepareGeneration() {
        return Promise.resolve({
          ok: false,
          problem: { code: "build-workspace-unavailable", harnessCommit },
        });
      },
    }),
  );

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({
    preparation: { ok: false, problem: { code: "build-workspace-unavailable" } },
  });
});
