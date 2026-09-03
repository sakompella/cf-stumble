/// <reference types="@cloudflare/vitest-plugin/types" />

import { expect, test } from "vitest";
import { parseHarnessCommit } from "../../src/harness-commit.js";
import { routeOwnerApiRequest } from "../../src/routes/index.js";
import type { GenerationRequest } from "../../src/supervisor/control/index.js";
import type { Generation, GenerationStatus } from "../../src/supervisor/generations/index.js";
import { parseGenerationLabel } from "../../src/supervisor/generations/index.js";
import type { OwnerApiSupervisor } from "../../src/routes/index.js";
import { controlRequest, ownerApiSupervisor as supervisor } from "./helpers.js";

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

function submissionBody(requestId: string, commit: string = harnessCommit): string {
  return JSON.stringify({ requestId, harnessCommit: commit });
}

const labeled = {
  ok: true,
  outcome: { kind: "candidate-submitted", generation: candidate("candidate"), epoch: 4 },
} as const;

const readyCheck = {
  ok: true,
  report: {
    stage: "ready",
    reason: "response body completed in 5 bytes",
    status: 200,
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
      reason: "response body completed in 5 bytes",
      status: 200,
      generation: { label: 1, harnessCommit, status: "ready" },
      effect: "recorded",
    },
  },
};

type RecordedSubmission = {
  readonly steps: string[];
  readonly received: GenerationRequest[];
  readonly preparedLabels: number[];
};

function recordingSupervisor(record: RecordedSubmission): OwnerApiSupervisor {
  return supervisor({
    controlGeneration(request) {
      record.steps.push("control");
      record.received.push(request);
      return Promise.resolve(labeled);
    },
    prepareGeneration(label) {
      record.steps.push("prepare");
      record.preparedLabels.push(label);
      return Promise.resolve(readyCheck);
    },
  });
}

test("labels the commit through the journaled control operation, then prepares that label", async () => {
  const record: RecordedSubmission = { steps: [], received: [], preparedLabels: [] };

  const response = await routeOwnerApiRequest(
    submitRequest(submissionBody("submit-1")),
    recordingSupervisor(record),
  );

  expect(record.received, "the principal is derived here, never taken from the request").toEqual([
    {
      requestId: "submit-1",
      principal: { kind: "user" },
      command: { kind: "submit-candidate", harnessCommit },
    },
  ]);
  expect(record.steps, "the label must exist before the candidate is prepared").toEqual([
    "control",
    "prepare",
  ]);
  expect(record.preparedLabels).toEqual([1]);
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual(expectedLabeledAndPrepared);
});

test("returns a failed startup check as the recorded preparation result", async () => {
  const response = await routeOwnerApiRequest(
    submitRequest(submissionBody("submit-failed-startup")),
    supervisor({
      controlGeneration() {
        return Promise.resolve(labeled);
      },
      prepareGeneration() {
        return Promise.resolve({
          ok: true,
          report: {
            stage: "response-rejected",
            reason: "response status was 500",
            status: 500,
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
    preparation: { ok: true, report: { stage: "response-rejected", effect: "recorded" } },
  });
});

test("returns a build failure as a preparation problem rather than a transport error", async () => {
  const response = await routeOwnerApiRequest(
    submitRequest(submissionBody("submit-unbuildable")),
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

test("prepares nothing when the control operation rejects the submission", async () => {
  let prepared = false;
  const response = await routeOwnerApiRequest(
    submitRequest(submissionBody("already-used")),
    supervisor({
      controlGeneration() {
        return Promise.resolve({ ok: false, problem: { code: "reused-request-id" } });
      },
      prepareGeneration() {
        prepared = true;
        return Promise.resolve({ ok: false, problem: { code: "unknown-generation", label: 1 } });
      },
    }),
  );

  expect(prepared, "an unlabeled commit has nothing to prepare").toBe(false);
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({
    ok: false,
    problem: { code: "reused-request-id" },
  });
});

const malformedBodies: readonly (readonly [string, string])[] = [
  ["unparsable JSON", '{"requestId":'],
  ["a JSON string", '"submit"'],
  ["a missing harness commit", '{"requestId":"r"}'],
  ["a missing request ID", `{"harnessCommit":"${harnessCommit}"}`],
  ["an observed epoch", `{"requestId":"r","harnessCommit":"${harnessCommit}","observedEpoch":0}`],
  ["an unknown key", `{"requestId":"r","harnessCommit":"${harnessCommit}","tenant":"other"}`],
  [
    "a supervisor name",
    `{"requestId":"r","harnessCommit":"${harnessCommit}","supervisorName":"other"}`,
  ],
  ["an empty request ID", `{"requestId":"","harnessCommit":"${harnessCommit}"}`],
  ["a request ID that is not a string", `{"requestId":7,"harnessCommit":"${harnessCommit}"}`],
  [
    "a control character in the request ID",
    `{"requestId":"a\\u0000b","harnessCommit":"${harnessCommit}"}`,
  ],
  ["a truncated harness commit", '{"requestId":"r","harnessCommit":"0123456789abcdef"}'],
  [
    "an uppercase harness commit",
    `{"requestId":"r","harnessCommit":"${harnessCommit.toUpperCase()}"}`,
  ],
  ["a branch name instead of a commit", '{"requestId":"r","harnessCommit":"refs/heads/main"}'],
  ["a harness commit that is not a string", '{"requestId":"r","harnessCommit":7}'],
  ["an array body", `[{"requestId":"r","harnessCommit":"${harnessCommit}"}]`],
];

test.each(malformedBodies)(
  "rejects a submission carrying %s without reaching the Supervisor",
  async (_description, body) => {
    let invoked = false;
    const response = await routeOwnerApiRequest(
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
  const response = await routeOwnerApiRequest(
    submitRequest(submissionBody("submit-control-throws")),
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
  const response = await routeOwnerApiRequest(
    submitRequest(submissionBody("submit-prepare-throws")),
    supervisor({
      controlGeneration() {
        return Promise.resolve(labeled);
      },
      prepareGeneration() {
        return Promise.reject(new Error("R2 rejected key with account secret sk-live-1"));
      },
    }),
  );

  expect(response.status).toBe(500);
  expect(await response.text()).toBe(
    JSON.stringify({ ok: false, error: { code: "internal-error" } }),
  );
});
