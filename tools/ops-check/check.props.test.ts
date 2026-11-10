import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  runChecks,
  type CheckInput,
  type Finding,
  type Invocation,
  type RunSettlement,
  type UsageBucket,
} from "./check.mts";

const MINUTE = 60_000;

const START = Date.parse("2026-10-01T00:00:00Z");

const BUCKET_MINUTES = 5;

const SLACK_MINUTES = 10;

const RUN_DEADLINE_MINUTES = 8;

const GRANTS_ALLOWANCE = [
  "/api/projects/connect",
  "/api/github/connection/refresh",
  "/api/generations/submit",
  "/api/workspace/reset",
  "/api/projects/:projectId/messages",
  "/api/projects/:projectId/disconnect",
];

const GRANTS_NONE = [
  "/api/status",
  "/api/projects",
  "/api/workspace/backend",
  "/api/projects/:projectId/events",
  "/api/projects/:projectId/entries",
  "/api/projects/:projectId/abort",
  "/api/projects/:projectId/thread/fresh",
  "/api/unknown",
  "/health",
  "/",
  "unknown",
];

type Call = { endMin: number; wallMin: number; route: string };

type Scenario = {
  idleMin: number;
  fromMin: number;
  toMin: number;
  lagSurplusMin: number;
  running: ReadonlyMap<number, number>;
  runStarts: readonly number[];
  settlements: readonly { atMin: number; totalMin: number }[];
  calls: readonly Call[];
};

const minutes = (min: number, max: number) => gs.integers({ minValue: min, maxValue: max });

function drawCalls(tc: hegel.TestCase, toMin: number): readonly Call[] {
  const ends = tc.draw(gs.arrays(minutes(-30, toMin + 10), { unique: true, maxSize: 5 }));

  return ends.map((endMin) => ({
    endMin,
    wallMin: tc.draw(minutes(0, 40)),
    route: tc.draw(gs.sampledFrom([...GRANTS_ALLOWANCE, ...GRANTS_NONE])),
  }));
}

function drawScenario(tc: hegel.TestCase): Scenario {
  const toMin = tc.draw(minutes(30, 120));
  const running = new Map<number, number>();

  for (let bucket = -3; bucket <= toMin / BUCKET_MINUTES + 2; bucket += 1) {
    running.set(bucket, tc.draw(gs.sampledFrom([0, 0, 5, 5, 5, 5, 5, 4, 3, 2, 1, 7])));
  }

  return {
    idleMin: tc.draw(minutes(1, 20)),
    fromMin: tc.draw(minutes(0, 10)),
    toMin,
    lagSurplusMin: tc.draw(minutes(0, 30)),
    running,
    runStarts: tc.draw(gs.arrays(minutes(-30, toMin), { maxSize: 3 })),
    settlements: tc.draw(
      gs.arrays(gs.record({ atMin: minutes(-30, toMin + 10), totalMin: minutes(0, 30) }), {
        maxSize: 3,
      }),
    ),
    calls: drawCalls(tc, toMin),
  };
}

function inputOf(
  scenario: Scenario,
  stamp: (ms: number, tc: hegel.TestCase) => number,
  tc: hegel.TestCase,
): CheckInput {
  const toMs = START + scenario.toMin * MINUTE;
  const at = (min: number) => stamp(START + min * MINUTE, tc);

  const usage: UsageBucket[] = [...scenario.running].map(([bucket, runningMinutes]) => ({
    startMs: START + bucket * BUCKET_MINUTES * MINUTE,
    runningMinutes,
  }));

  const invocations: Invocation[] = scenario.calls.map((call) => ({
    endMs: at(call.endMin),
    wallTimeMs: call.wallMin * MINUTE,
    route: call.route,
  }));

  const runSettlements: RunSettlement[] = scenario.settlements.map((settlement) => ({
    atMs: at(settlement.atMin),
    totalMs: settlement.totalMin * MINUTE,
  }));

  return {
    worker: "cf-stumble",
    nowMs: toMs + scenario.lagSurplusMin * MINUTE,
    window: { fromMs: START + scenario.fromMin * MINUTE, toMs },
    idleLimitMs: scenario.idleMin * MINUTE,
    activity: {
      status: "ok",
      data: {
        invocations,
        usage,
        sessionFailures: [],
        runStarts: scenario.runStarts.map(at),
        runSettlements,
      },
    },
  };
}

function allowedMinutes(scenario: Scenario): ReadonlySet<number> {
  const allowed = new Set<number>();

  const allow = (beginMin: number, endMin: number) => {
    for (let minute = Math.ceil(beginMin); minute < endMin; minute += 1) allowed.add(minute);
  };

  for (const start of scenario.runStarts) {
    allow(start, start + RUN_DEADLINE_MINUTES + scenario.idleMin);
  }

  for (const { atMin, totalMin } of scenario.settlements) {
    allow(atMin - totalMin, atMin + scenario.idleMin);
  }

  for (const call of scenario.calls) {
    if (GRANTS_ALLOWANCE.includes(call.route)) {
      allow(call.endMin - call.wallMin, call.endMin + scenario.idleMin);
    }
  }

  return allowed;
}

const iso = (min: number) => new Date(START + min * MINUTE).toISOString().slice(0, 16) + "Z";

function unallowedMinutes(allowed: ReadonlySet<number>, bucket: number, running: number): number {
  const first = bucket * BUCKET_MINUTES;

  const covered = Array.from({ length: BUCKET_MINUTES }, (_, offset) => first + offset).filter(
    (minute) => allowed.has(minute),
  ).length;

  return Math.max(0, Math.min(running, BUCKET_MINUTES) - covered);
}

function expectedEvidence(scenario: Scenario, endMin: number): readonly string[] {
  const latest = scenario.calls
    .filter((call) => call.route.startsWith("/api/") && call.endMin <= endMin)
    .toSorted((left, right) => right.endMin - left.endMin)
    .slice(0, 3)
    .map((call) => `${call.route}@${iso(call.endMin).slice(11)}`);

  return latest.length === 0 ? ["no requests seen"] : latest;
}

function expectedFindings(scenario: Scenario): readonly Finding[] {
  const completeMin = Math.min(scenario.toMin, scenario.toMin + scenario.lagSurplusMin - 10);
  const allowed = allowedMinutes(scenario);

  const judged = [...scenario.running]
    .filter(
      ([bucket, running]) =>
        running > 0 &&
        bucket * BUCKET_MINUTES >= scenario.fromMin &&
        (bucket + 1) * BUCKET_MINUTES <= completeMin,
    )
    .toSorted(([left], [right]) => left - right);

  const runs: (typeof judged)[] = [];

  for (const entry of judged) {
    const run = runs.at(-1);

    if (run?.at(-1)?.[0] === entry[0] - 1) run.push(entry);
    else runs.push([entry]);
  }

  return runs.flatMap((run): Finding[] => {
    const overrun = run.reduce(
      (sum, [bucket, running]) => sum + unallowedMinutes(allowed, bucket, running),
      0,
    );

    const beginMin = (run[0]?.[0] ?? 0) * BUCKET_MINUTES;
    const endMin = ((run.at(-1)?.[0] ?? 0) + 1) * BUCKET_MINUTES;

    if (overrun <= SLACK_MINUTES) return [];

    return [
      {
        rule: "ran-past-idle",
        detail: `container ran ${iso(beginMin)}..${iso(endMin).slice(11)}, ${overrun} min > ${SLACK_MINUTES} min beyond requests plus the ${scenario.idleMin} min idle limit`,
        evidence: expectedEvidence(scenario, endMin),
      },
    ];
  });
}

const whole = (ms: number) => ms;

const jittered = (ms: number, tc: hegel.TestCase) => ms + tc.draw(minutes(0, 59_999));

function shuffled<T>(tc: hegel.TestCase, items: readonly T[]): readonly T[] {
  const keys = items.map(() => tc.draw(minutes(0, 1000)));

  return items
    .map((item, index) => ({ item, key: keys[index] ?? 0 }))
    .toSorted((left, right) => left.key - right.key)
    .map(({ item }) => item);
}

test("reports a run of contiguous running time iff more than 10 of its minutes lie outside every allowance", () => {
  hegel.test(
    (tc) => {
      const scenario = tc.draw(gs.composite(drawScenario));
      const input = inputOf(scenario, whole, tc);

      assert.deepEqual(runChecks(input), expectedFindings(scenario));
    },
    { testCases: 300 },
  );
});

test("findings do not depend on the order of invocations, usage buckets, run starts or settlements", () => {
  hegel.test((tc) => {
    const scenario = tc.draw(gs.composite(drawScenario));
    const input = inputOf(scenario, jittered, tc);

    assert.equal(input.activity.status, "ok");

    const { data } = input.activity;

    const reordered: CheckInput = {
      ...input,
      activity: {
        status: "ok",
        data: {
          ...data,
          invocations: shuffled(tc, data.invocations),
          usage: shuffled(tc, data.usage),
          runStarts: shuffled(tc, data.runStarts),
          runSettlements: shuffled(tc, data.runSettlements),
        },
      },
    };

    assert.deepEqual(runChecks(reordered), runChecks(input));
  });
});
