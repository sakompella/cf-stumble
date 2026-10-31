import { afterEach, expect, test, vi } from "vitest";
import { parseHarnessCommit } from "../../src/harness-commit.js";
import type { GenerationCommand } from "../../src/supervisor/control/index.js";
import type { Generation, GenerationStatus } from "../../src/supervisor/generations/index.js";
import { parseGenerationLabel } from "../../src/supervisor/generations/index.js";
import type { OwnerApiSupervisor } from "../../src/routes/index.js";
import { capturedEvents, everythingLogged } from "../log-capture.js";
import { controlRequest, ownerApiResponse, ownerApiSupervisor as supervisor } from "./helpers.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const harnessCommit = "0123456789abcdef0123456789abcdef01234567";

function candidate(status: GenerationStatus): Generation {
  const label = parseGenerationLabel(1);
  const commit = parseHarnessCommit(harnessCommit);

  if (label === undefined || commit === undefined) {
    throw new Error("test fixture must contain a valid label and harness commit");
  }

  return { label, harnessCommit: commit, status };
}

function submitRequest(body: string): Request {
  return controlRequest("/api/generations/submit", body);
}

function submissionBody(commit: string = harnessCommit): string {
  return JSON.stringify({ harnessCommit: commit });
}

const labeled = {
  ok: true,
  outcome: { kind: "candidate-submitted", generation: candidate("candidate"), epoch: 4 },
} as const;

const readyCheck = {
  ok: true,
  report: {
    stage: "ready",
    reason: "the generation runs Pi Durable 1.4.0",
    generation: candidate("ready"),
    effect: "recorded",
  },
} as const;

const expectedLabeledAndPrepared = {
  ok: true,
  outcome: {
    kind: "candidate-submitted",
    generation: { label: 1, harnessCommit, status: "candidate" },
    epoch: 4,
  },
  preparation: {
    ok: true,
    report: {
      stage: "ready",
      reason: "the generation runs Pi Durable 1.4.0",
      generation: { label: 1, harnessCommit, status: "ready" },
      effect: "recorded",
    },
  },
};

type RecordedSubmission = {
  readonly steps: string[];
  readonly received: GenerationCommand[];
  readonly preparedLabels: number[];
  submissions: number;
};

function recordingSupervisor(record: RecordedSubmission): OwnerApiSupervisor {
  return supervisor({
    controlGeneration(command) {
      record.steps.push("control");
      record.received.push(command);
      record.submissions += 1;

      return Promise.resolve(labeled);
    },
    prepareGeneration(label) {
      record.steps.push("prepare");
      record.preparedLabels.push(label);

      return Promise.resolve(readyCheck);
    },
  });
}

test("labels the commit directly, then prepares that label", async () => {
  const record: RecordedSubmission = {
    steps: [],
    received: [],
    preparedLabels: [],
    submissions: 0,
  };

  const response = await ownerApiResponse(
    submitRequest(submissionBody()),
    recordingSupervisor(record),
  );

  expect(record.received).toEqual([{ kind: "submit-candidate", harnessCommit }]);
  expect(record.steps, "the label must exist before the candidate is prepared").toEqual([
    "control",
    "prepare",
  ]);
  expect(record.preparedLabels).toEqual([1]);
  expect(record.submissions).toBe(1);
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual(expectedLabeledAndPrepared);
});

test("returns a failed startup check as the recorded preparation result", async () => {
  const response = await ownerApiResponse(
    submitRequest(submissionBody()),
    supervisor({
      controlGeneration() {
        return Promise.resolve(labeled);
      },
      prepareGeneration() {
        return Promise.resolve({
          ok: true,
          report: {
            stage: "version-mismatch",
            reason: "the generation runs Pi Durable 0.0.1; this Supervisor stores 1.4.0",
            generation: candidate("failed"),
            effect: "recorded",
          },
        });
      },
    }),
  );

  expect(response.status, "a checked candidate that fails is a decision, not a fault").toBe(200);
  await expect(response.json()).resolves.toMatchObject({
    ok: true,
    preparation: { ok: true, report: { stage: "version-mismatch", effect: "recorded" } },
  });
});

test("returns a build failure as a preparation problem rather than a transport error", async () => {
  const response = await ownerApiResponse(
    submitRequest(submissionBody()),
    supervisor({
      controlGeneration() {
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
    ok: true,
    preparation: { ok: false, problem: { code: "build-workspace-unavailable", harnessCommit } },
  });
});

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
      controlGeneration() {
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

test("prepares nothing when the control operation rejects the submission", async () => {
  let prepared = false;

  const response = await ownerApiResponse(
    submitRequest(submissionBody()),
    supervisor({
      controlGeneration() {
        return Promise.resolve({ ok: false, problem: { code: "invalid-harness-commit" } });
      },
      prepareGeneration() {
        prepared = true;

        return Promise.resolve({ ok: false, problem: { code: "unknown-generation", label: 1 } });
      },
    }),
  );

  expect(prepared, "an unlabeled commit has nothing to prepare").toBe(false);
  expect(response.status).toBe(400);
  await expect(response.json()).resolves.toEqual({
    ok: false,
    problem: { code: "invalid-harness-commit" },
  });
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
        controlGeneration() {
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

test("reports a labeling failure without echoing the internal error", async () => {
  const response = await ownerApiResponse(
    submitRequest(submissionBody()),
    supervisor({
      controlGeneration() {
        return Promise.reject(new Error("Bearer token-abc leaked from SQLite"));
      },
    }),
  );

  expect(response.status).toBe(500);
  expect(await response.text()).toBe(
    JSON.stringify({ ok: false, error: { code: "internal-error" } }),
  );
});

test("reports a preparation failure without echoing the internal error", async () => {
  const response = await ownerApiResponse(
    submitRequest(submissionBody()),
    supervisor({
      controlGeneration() {
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
