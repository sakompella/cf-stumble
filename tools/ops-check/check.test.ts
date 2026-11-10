import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  activityWindow,
  BUCKET_MS,
  cacheHitLine,
  formatReport,
  isoMinute,
  METRICS_LAG_MS,
  MINUTE_MS,
  runChecks,
  type CheckInput,
  type Invocation,
  type RunSettlement,
  type SessionFailure,
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
  sessionFailures: readonly SessionFailure[] = [],
  runStarts: readonly number[] = [],
  runSettlements: readonly RunSettlement[] = [],
): CheckInput {
  const toMs = START + windowMinutes * MINUTE_MS;

  return {
    worker: "cf-stumble",
    nowMs: toMs + 60 * MINUTE_MS,
    window: { fromMs: START, toMs },
    idleLimitMs: IDLE_LIMIT_MS,
    activity: {
      status: "ok",
      data: { invocations, usage, sessionFailures, runStarts, runSettlements },
    },
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

  it("queries activity back through the run deadline and idle limit from the first bucket", () => {
    const window = { fromMs: START + 4 * MINUTE_MS, toMs: START + 120 * MINUTE_MS };

    assert.deepEqual(activityWindow(window, IDLE_LIMIT_MS), {
      fromMs: START - 18 * MINUTE_MS,
      toMs: START + 120 * MINUTE_MS,
    });
  });
});

describe("conversation runs", () => {
  it("allows a started run its eight-minute deadline before the idle limit starts", () => {
    assert.deepEqual(
      rules(check([request(0, RUN_ROUTE)], runningBetween(0, 25), 120, [], [START])),
      [],
    );
    assert.deepEqual(
      rules(check([request(0, RUN_ROUTE)], runningBetween(0, 30), 120, [], [START])),
      ["ran-past-idle"],
    );
  });

  it("allows queued runs their own lifetimes behind one-at-a-time admissions", () => {
    const messages = [request(0, RUN_ROUTE), request(1, RUN_ROUTE), request(2, RUN_ROUTE)];

    const runSettlements = [7, 14, 21].map((atMinutes) => ({
      atMs: START + atMinutes * MINUTE_MS,
      totalMs: 7 * MINUTE_MS,
    }));

    const usage = [
      ...runningBetween(0, 30),
      { startMs: START + 30 * MINUTE_MS, runningMinutes: 1 },
    ];

    assert.deepEqual(rules(check(messages, usage, 120, [], [], runSettlements)), []);
  });

  it("allows back-to-back message runs to keep the container running between them", () => {
    const messages = [request(0, RUN_ROUTE), request(17, RUN_ROUTE)];
    const runStarts = [START, START + 17 * MINUTE_MS];

    assert.deepEqual(rules(check(messages, runningBetween(0, 35), 120, [], runStarts)), []);
  });

  it("judges only whole buckets inside a non-aligned window, with activity from before it", () => {
    const runSettlements = [{ atMs: START + 1.8 * MINUTE_MS, totalMs: 7.9 * MINUTE_MS }];

    const input = {
      ...check([], runningBetween(0, 15), 120, [], [], runSettlements),
      window: { fromMs: START + 4 * MINUTE_MS, toMs: START + 120 * MINUTE_MS },
    };

    assert.deepEqual(rules(input), []);
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

    assert.deepEqual(formatReport(stillFilling, runChecks(stillFilling), null), [
      `✓ ops-check cf-stumble ${isoMinute(START)}..${isoMinute(stillFilling.nowMs - METRICS_LAG_MS).slice(11)}`,
    ]);
    assert.deepEqual(formatReport(settled, runChecks(settled), null), [
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

describe("facet.session-failed", () => {
  it("reports a failure in the window with its cause and time", () => {
    const failure = { atMs: START + 5 * MINUTE_MS, cause: "storage reset" };

    const findings = runChecks(check([], [], 120, [failure]));

    assert.deepEqual(findings, [
      {
        rule: "facet.session-failed",
        detail: "1 facet session failure(s); first: storage reset",
        evidence: [isoMinute(failure.atMs)],
      },
    ]);
  });
});

describe("cacheHitLine", () => {
  it("sums cached over prompt tokens and says nothing without calls", () => {
    const calls = [
      { promptTokens: 1000, cachedTokens: 900 },
      { promptTokens: 1000, cachedTokens: 500 },
    ];

    assert.deepEqual(cacheHitLine({ calls, sample: false }), [
      "i model cache hit rate 70.0% (1400/2000 prompt tokens, 2 calls)",
    ]);
    assert.deepEqual(cacheHitLine({ calls: [], sample: false }), []);
  });

  it("says when a full page makes the rate a sample", () => {
    const [line] = cacheHitLine({ calls: [{ promptTokens: 10, cachedTokens: 5 }], sample: true });

    assert.match(line ?? "", /a sample/u);
  });
});
