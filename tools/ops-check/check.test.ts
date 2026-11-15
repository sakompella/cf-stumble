import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  activityWindow,
  BUCKET_MS,
  modelCallLines,
  formatReport,
  METRICS_LAG_MS,
  MINUTE_MS,
  runChecks,
  type Activity,
  type CheckInput,
  type UsageBucket,
} from "./check.mts";

const START = Date.parse("2026-10-01T00:00:00Z");

const IDLE_LIMIT_MS = 10 * MINUTE_MS;

function runningBetween(fromMinutes: number, toMinutes: number): readonly UsageBucket[] {
  const count = (toMinutes - fromMinutes) / (BUCKET_MS / MINUTE_MS);

  return Array.from({ length: count }, (_, index) => ({
    startMs: START + fromMinutes * MINUTE_MS + index * BUCKET_MS,
    runningMinutes: BUCKET_MS / MINUTE_MS,
  }));
}

function check(
  usage: readonly UsageBucket[],
  windowMinutes = 120,
  activity: Partial<Activity> = {},
): CheckInput {
  const toMs = START + windowMinutes * MINUTE_MS;

  return {
    worker: "cf-stumble",
    nowMs: toMs + 60 * MINUTE_MS,
    window: { fromMs: START, toMs },
    idleLimitMs: IDLE_LIMIT_MS,
    activity: {
      status: "ok",
      data: {
        invocations: [],
        usage,
        sessionFailures: [],
        runStarts: [],
        runSettlements: [],
        ...activity,
      },
    },
  };
}

const rules = (input: CheckInput) => runChecks(input).map((finding) => finding.rule);

describe("activity from before the window", () => {
  it("is queried back through the run deadline and idle limit from the first bucket (c7ecf2d7)", () => {
    const window = { fromMs: START + 4 * MINUTE_MS, toMs: START + 120 * MINUTE_MS };

    assert.deepEqual(activityWindow(window, IDLE_LIMIT_MS), {
      fromMs: START - 18 * MINUTE_MS,
      toMs: START + 120 * MINUTE_MS,
    });
  });

  it("covers a whole bucket of a non-aligned window with a run that settled mid-minute (c7ecf2d7)", () => {
    const runSettlements = [{ atMs: START + 1.8 * MINUTE_MS, totalMs: 7.9 * MINUTE_MS }];

    const input = {
      ...check(runningBetween(0, 15), 120, { runSettlements }),
      window: { fromMs: START + 4 * MINUTE_MS, toMs: START + 120 * MINUTE_MS },
    };

    assert.deepEqual(rules(input), []);
  });
});

describe("the window the check can see", () => {
  it("is unknown, not fine, while usage lag leaves nothing of the window complete", () => {
    for (const sinceWindowStartMs of [0, METRICS_LAG_MS / 2, METRICS_LAG_MS]) {
      const input = { ...check([], 5), nowMs: START + sinceWindowStartMs };

      assert.deepEqual(
        rules(input),
        ["unknown"],
        `${sinceWindowStartMs} ms after the window began`,
      );
    }
  });

  it("is judged once usage lag leaves part of the window complete", () => {
    const input = { ...check([], 5), nowMs: START + METRICS_LAG_MS + MINUTE_MS };

    assert.deepEqual(rules(input), []);
  });

  it("ends the green line at now minus the usage lag, or at the window's end if that is earlier", () => {
    const stillFilling = { ...check([], 120), nowMs: START + 125 * MINUTE_MS };
    const settled = check([], 120);

    assert.deepEqual(formatReport(stillFilling, runChecks(stillFilling), null), [
      "✓ ops-check cf-stumble 2026-10-01T00:00Z..01:55Z",
    ]);
    assert.deepEqual(formatReport(settled, runChecks(settled), null), [
      "✓ ops-check cf-stumble 2026-10-01T00:00Z..02:00Z",
    ]);
  });
});

describe("unknown", () => {
  it("reports an unavailable source instead of passing", () => {
    const input: CheckInput = {
      ...check([]),
      activity: { status: "unavailable", reason: "no token" },
    };

    assert.deepEqual(runChecks(input), [{ rule: "unknown", detail: "no token", evidence: [] }]);
  });
});

describe("facet.session-failed", () => {
  it("reports a failure in the window with its cause and time", () => {
    const failure = { atMs: START + 5 * MINUTE_MS, cause: "storage reset" };

    const findings = runChecks(check([], 120, { sessionFailures: [failure] }));

    assert.deepEqual(findings, [
      {
        rule: "facet.session-failed",
        detail: "1 facet session failure(s); first: storage reset",
        evidence: ["2026-10-01T00:05Z"],
      },
    ]);
  });
});

describe("modelCallLines", () => {
  it("counts calls and sums cached over prompt tokens for each provider, and says nothing without calls", () => {
    const calls = [
      { provider: "workers-ai", promptTokens: 1000, cachedTokens: 900 },
      { provider: "chatgpt", promptTokens: 0, cachedTokens: 0 },
      { provider: "workers-ai", promptTokens: 1000, cachedTokens: 500 },
    ];

    assert.deepEqual(modelCallLines({ calls, sample: false }), [
      "i model calls chatgpt: 1, cache hit rate n/a (0/0 prompt tokens)",
      "i model calls workers-ai: 2, cache hit rate 70.0% (1400/2000 prompt tokens)",
    ]);
    assert.deepEqual(modelCallLines({ calls: [], sample: false }), []);
  });

  it("says when a full page makes the counts a sample", () => {
    const [line] = modelCallLines({
      calls: [{ provider: "chatgpt", promptTokens: 10, cachedTokens: 5 }],
      sample: true,
    });

    assert.match(line ?? "", /a sample/u);
  });
});
