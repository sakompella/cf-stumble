import { afterEach, expect, test, vi } from "vitest";
import type { Generation, GenerationStatus } from "../../src/supervisor/generations.js";
import { testHarnessCommit } from "../harness-commit-fixtures.js";
import { label as generationLabel } from "../supervisor/generations/fixtures.js";
import { capturedEvents, everythingLogged } from "../log-capture.js";
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

test("returns a failed build step's output tail to the owner and writes none of it to a log", async () => {
  const diagnostics = {
    stdoutTail: "",
    stderrTail: "error TS2322: PRIVATE-COMPILER-OUTPUT",
    truncated: false,
  };

  capturedEvents();

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
  expect(everythingLogged()).not.toContain("PRIVATE-COMPILER-OUTPUT");
});

const malformedBodies: readonly (readonly [string, string])[] = [
  ["unparsable JSON", '{"harnessCommit":'],
  ["a JSON string", '"submit"'],
  ["a missing harness commit", "{}"],
  ["a request ID", `{"harnessCommit":"${harnessCommit}","requestId":"r"}`],
  ["an observed epoch", `{"harnessCommit":"${harnessCommit}","observedEpoch":0}`],
  ["an unknown key", `{"harnessCommit":"${harnessCommit}","tenant":"other"}`],
  ["a supervisor name", `{"harnessCommit":"${harnessCommit}","supervisorName":"other"}`],
  ["a truncated harness commit", '{"harnessCommit":"0123456789abcdef"}'],
  ["a harness commit that is not a string", '{"harnessCommit":7}'],
  ["an array body", `[{"harnessCommit":"${harnessCommit}"}]`],
];

test.each(malformedBodies)(
  "rejects a submission carrying %s without reaching the Supervisor",
  async (_description, body) => {
    let invoked = false;

    const response = await ownerApiResponse(
      submitRequest(body),
      supervisor({
        submitGeneration() {
          invoked = true;

          return Promise.resolve(labeled);
        },
        prepareGeneration() {
          invoked = true;

          return Promise.resolve({ ok: false, problem: { code: "unknown-generation", label: 1 } });
        },
      }),
    );

    expect(invoked).toBe(false);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: { code: "invalid-submission-request" },
    });
  },
);

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
