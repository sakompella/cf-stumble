import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BUCKET_MS,
  formatReport,
  isoMinute,
  METRICS_LAG_MS,
  MINUTE_MS,
  runChecks,
  type CheckInput,
  type Invocation,
  type UsageBucket,
} from "./check.mts";

const START = Date.parse("2026-10-01T00:00:00Z");

const IDLE_LIMIT_MS = 10 * MINUTE_MS;

const WORKSPACE_ROUTE = "/api/projects/connect";

const RUN_ROUTE = "/api/projects/:projectId/messages";

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
  it("passes a scanner's stray /api requests while the container is stopped", () => {
    assert.deepEqual(
      rules(check([request(0, "/api/unknown"), request(5, "/api/unknown")], [])),
      [],
    );
  });

  it("gives a stray /api request no allowance, so a container it kept running is reported", () => {
    assert.deepEqual(rules(check([request(0, "/api/unknown")], runningBetween(0, 20))), [
      "ran-past-idle",
    ]);
  });

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

  it("gives the owner page's events stream no allowance, however long it stays open", () => {
    const stream = {
      ...request(120, "/api/projects/:projectId/events"),
      wallTimeMs: 120 * MINUTE_MS,
    };

    assert.deepEqual(rules(check([stream], runningBetween(0, 120))), ["ran-past-idle"]);
  });

  it("allows a message's run its eight-minute deadline before the idle limit starts", () => {
    assert.deepEqual(rules(check([request(0, RUN_ROUTE)], runningBetween(0, 25))), []);
    assert.deepEqual(rules(check([request(0, RUN_ROUTE)], runningBetween(0, 30))), [
      "ran-past-idle",
    ]);
  });

  it("allows back-to-back message runs to keep the container running between them", () => {
    const messages = [request(0, RUN_ROUTE), request(17, RUN_ROUTE)];

    assert.deepEqual(rules(check(messages, runningBetween(0, 35))), []);
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

describe("the window the check can see", () => {
  it("is unknown, not fine, while usage lag leaves nothing of the window complete", () => {
    for (const sinceWindowStartMs of [0, METRICS_LAG_MS / 2, METRICS_LAG_MS]) {
      const input = { ...check([], [], 5), nowMs: START + sinceWindowStartMs };

      assert.deepEqual(
        rules(input),
        ["unknown"],
        `${sinceWindowStartMs} ms after the window began`,
      );
    }
  });

  it("is judged once usage lag leaves part of the window complete", () => {
    const input = { ...check([], [], 5), nowMs: START + METRICS_LAG_MS + MINUTE_MS };

    assert.deepEqual(rules(input), []);
  });

  it("ends the green line at now minus the usage lag, or at the window's end if that is earlier", () => {
    const stillFilling = { ...check([], [], 120), nowMs: START + 125 * MINUTE_MS };
    const settled = check([], [], 120);

    assert.deepEqual(formatReport(stillFilling, runChecks(stillFilling)), [
      `✓ ops-check cf-stumble ${isoMinute(START)}..${isoMinute(stillFilling.nowMs - METRICS_LAG_MS).slice(11)}`,
    ]);
    assert.deepEqual(formatReport(settled, runChecks(settled)), [
      `✓ ops-check cf-stumble ${isoMinute(START)}..${isoMinute(settled.window.toMs).slice(11)}`,
    ]);
  });
});

describe("unknown", () => {
  it("reports an unavailable source instead of passing", () => {
    const input: CheckInput = {
      ...check([], []),
      activity: { status: "unavailable", reason: "no token" },
    };

    assert.deepEqual(runChecks(input), [{ rule: "unknown", detail: "no token", evidence: [] }]);
  });
});
