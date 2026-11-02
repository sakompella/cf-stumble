import { afterEach, expect, test, vi } from "vitest";
import type { Generation, GenerationStatus } from "../../src/supervisor/generations.js";
import { testHarnessCommit } from "../harness-commit-fixtures.js";
import { label as generationLabel } from "../supervisor/generations/fixtures.js";
import { controlRequest, ownerApiResponse, ownerApiSupervisor as supervisor } from "./helpers.js";

afterEach(() => {
  vi.restoreAllMocks();
});

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

  const response = await ownerApiResponse(
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

test("reports a preparation failure without echoing the internal error", async () => {
  const response = await ownerApiResponse(
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
  expect(await response.text()).toBe(
    JSON.stringify({ ok: false, error: { code: "internal-error" } }),
  );
});
