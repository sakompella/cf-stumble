import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Preparation } from "../../src/api/answers.ts";
import { releaseOwner, type Answer, type ApiClient } from "./owner.mts";

const COMMIT = "b".repeat(40);

type Prepared = typeof Preparation.Type;

const CANDIDATE = { label: 7, harnessCommit: COMMIT, status: "candidate" } as const;

const READY: Prepared = {
  ok: true,
  report: {
    stage: "ready",
    reason: "ok",
    generation: { ...CANDIDATE, status: "ready" },
    effect: "recorded",
  },
};

const STEP_FAILED: Prepared = {
  ok: false,
  problem: {
    code: "build-step-failed",
    harnessCommit: COMMIT,
    step: "install",
    exitCode: 1,
    diagnostics: { stdoutTail: "", stderrTail: "", truncated: false },
  },
};

function submitted(preparation: Prepared): Answer {
  const outcome = { kind: "candidate-submitted", generation: CANDIDATE, epoch: 1 };

  return { status: 200, text: JSON.stringify({ ok: true, outcome, preparation }) };
}

function submitting(answer: Answer | Error): ReturnType<typeof releaseOwner> {
  const client: ApiClient = {
    get: () => Promise.reject(new Error("a submit does not read the status")),
    post: () => (answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer)),
  };

  return releaseOwner(client);
}

describe("a submit answer that is ready or interrupted", () => {
  it("is ready when the startup check passed", async () => {
    assert.deepEqual(await submitting(submitted(READY)).submit(COMMIT, 1_000), {
      kind: "ready",
      label: 7,
    });
  });

  it("is interrupted when the build workspace was unavailable", async () => {
    const problem = { code: "build-workspace-unavailable", harnessCommit: COMMIT } as const;
    const answer = await submitting(submitted({ ok: false, problem })).submit(COMMIT, 1_000);

    assert.equal(answer.kind, "interrupted");
  });

  it("is interrupted when the Worker says the platform interrupted the call, with the recorded label", async () => {
    const text = JSON.stringify({
      ok: false,
      error: { code: "infrastructure-interrupted" },
      recorded: { label: 7, harnessCommit: COMMIT },
    });

    assert.deepEqual(await submitting({ status: 503, text }).submit(COMMIT, 1_000), {
      kind: "interrupted",
      reason: "infrastructure-interrupted, label 7 recorded",
    });
  });

  it("is interrupted when the request did not complete", async () => {
    const answer = await submitting(new Error("fetch failed")).submit(COMMIT, 1_000);

    assert.deepEqual(answer, {
      kind: "interrupted",
      reason: "the request did not complete: fetch failed",
    });
  });
});

describe("a submit answer that is final", () => {
  it("is a failure for a failed build step", async () => {
    const answer = await submitting(submitted(STEP_FAILED)).submit(COMMIT, 1_000);

    assert.equal(answer.kind, "failed");
  });

  it("is a failure for a startup check that did not pass", async () => {
    const report = { ...READY, report: { ...READY.report, stage: "conversation-failed" } } as const;
    const answer = await submitting(submitted(report)).submit(COMMIT, 1_000);

    assert.equal(answer.kind, "failed");
  });

  it("throws on any other HTTP answer, so a 500 is never repeated", async () => {
    const text = '{"ok":false,"error":{"code":"internal-error"}}';

    await assert.rejects(
      submitting({ status: 500, text }).submit(COMMIT, 1_000),
      /the API answered 500/u,
    );
  });

  it("hands the remaining time to the request", async () => {
    const timeouts: (number | undefined)[] = [];

    const owner = releaseOwner({
      get: () => Promise.reject(new Error("unused")),
      post: (_path, _body, timeoutMs) => {
        timeouts.push(timeoutMs);

        return Promise.resolve(submitted(READY));
      },
    });

    await owner.submit(COMMIT, 4_321);

    assert.deepEqual(timeouts, [4_321]);
  });
});
