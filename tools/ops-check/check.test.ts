import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BUCKET_MS,
  MINUTE_MS,
  runChecks,
  type CheckInput,
  type Invocation,
  type UsageBucket,
} from "./check.mts";

const START = Date.parse("2026-10-01T00:00:00Z");

const IDLE_LIMIT_MS = 10 * MINUTE_MS;

const WORKSPACE_ROUTE = "/api/projects/:projectId/messages";

const request = (afterMinutes: number, route = WORKSPACE_ROUTE): Invocation => ({
  endMs: START + afterMinutes * MINUTE_MS,
  wallTimeMs: 0,
  route,
});

function runningBetween(fromMinutes: number, toMinutes: number): readonly UsageBucket[] {
  const count = (toMinutes - fromMinutes) / (BUCKET_MS / MINUTE_MS);

  return Array.from({ length: count }, (_, index) => ({
    startMs: START + fromMinutes * MINUTE_MS + index * BUCKET_MS,
    runningMinutes: BUCKET_MS / MINUTE_MS,
  }));
}

function check(
  invocations: readonly Invocation[],
  usage: readonly UsageBucket[],
  windowMinutes = 120,
): CheckInput {
  const toMs = START + windowMinutes * MINUTE_MS;

  return {
    worker: "cf-stumble",
    nowMs: toMs + 60 * MINUTE_MS,
    window: { fromMs: START, toMs },
    idleLimitMs: IDLE_LIMIT_MS,
    activity: { status: "ok", data: { invocations, usage } },
  };
}

const rules = (input: CheckInput) => runChecks(input).map((finding) => finding.rule);

describe("ran-past-idle", () => {
  it("fires when running exceeds the idle limit by more than the slack, not at it", () => {
    assert.deepEqual(rules(check([request(0)], runningBetween(0, 20))), []);
    assert.deepEqual(rules(check([request(0)], runningBetween(0, 25))), ["ran-past-idle"]);
  });

  it("lets a later request extend the allowance", () => {
    const requests = [request(0), request(10)];

    assert.deepEqual(rules(check([request(0)], runningBetween(0, 30))), ["ran-past-idle"]);
    assert.deepEqual(rules(check(requests, runningBetween(0, 30))), []);
    assert.deepEqual(rules(check(requests, runningBetween(0, 35))), ["ran-past-idle"]);
  });

  it("counts a request's own running time as allowed", () => {
    const longRequest = { ...request(60), wallTimeMs: 60 * MINUTE_MS };

    assert.deepEqual(rules(check([longRequest], runningBetween(0, 80))), []);
  });

  it("allows running time only for owner API requests", () => {
    const longPage = { ...request(60, "/"), wallTimeMs: 60 * MINUTE_MS };

    assert.deepEqual(rules(check([longPage], runningBetween(0, 80))), ["ran-past-idle"]);
  });
});

describe("route classes", () => {
  it("gives record-only reads no allowance, however often they are polled", () => {
    const polls = Array.from({ length: 24 }, (_, index) => request(index * 5, "/api/status"));

    assert.deepEqual(rules(check([request(0), ...polls], runningBetween(0, 120))), [
      "ran-past-idle",
    ]);
  });

  it("keeps the allowance for every route that can reach the workspace", () => {
    for (const route of [
      "/api/projects/:projectId/messages",
      "/api/projects/:projectId/events",
      "/api/projects/:projectId/abort",
      "/api/projects/:projectId/thread/fresh",
      "/api/projects/:projectId/disconnect",
      "/api/projects/connect",
      "/api/github/connection/refresh",
      "/api/workspace/reset",
      "/api/generations/submit",
    ]) {
      assert.deepEqual(rules(check([request(0, route)], runningBetween(0, 20))), [], route);
      assert.deepEqual(rules(check([request(0, route)], runningBetween(0, 25))), ["ran-past-idle"]);
    }
  });

  it("flags a container that runs with no request at all", () => {
    assert.deepEqual(rules(check([], runningBetween(0, 15))), ["ran-past-idle"]);
  });

  it("ignores buckets the metrics have not filled yet", () => {
    const live = { ...check([request(0)], runningBetween(0, 25)), nowMs: START + 25 * MINUTE_MS };

    assert.deepEqual(rules(live), []);
  });

  it("names the latest requests before the overrun, newest first", () => {
    const requests = [
      request(0, "/api/status"),
      request(1, "/api/projects"),
      request(2, "/api/github/connection"),
      request(3, "/api/projects/connect"),
    ];

    const [finding] = runChecks(check(requests, runningBetween(0, 40)));

    assert.deepEqual(finding?.evidence, [
      "/api/projects/connect@00:03Z",
      "/api/github/connection@00:02Z",
      "/api/projects@00:01Z",
    ]);
  });
});

describe("unknown", () => {
  it("reports an /api route the checker does not classify instead of passing", () => {
    const stray = request(0, "/api/unknown");

    const [finding] = runChecks(check([stray], []));

    assert.equal(finding?.rule, "unknown");
    assert.deepEqual(finding?.evidence, ["/api/unknown@00:00Z"]);
  });

  it("gives an unclassified route no allowance", () => {
    assert.deepEqual(rules(check([request(0, "/api/unknown")], runningBetween(0, 20))), [
      "unknown",
      "ran-past-idle",
    ]);
  });

  it("reports an unavailable source instead of passing", () => {
    const input: CheckInput = {
      ...check([], []),
      activity: { status: "unavailable", reason: "no token" },
    };

    assert.deepEqual(runChecks(input), [{ rule: "unknown", detail: "no token", evidence: [] }]);
  });
});
