/** Boundary tests: each rule fires exactly at its threshold and not one step below. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bucketsOf, canceledInvocationRow, eventRow, input, logs, metrics } from "./fixtures.mts";
import { BUCKET_MS, MINUTE_MS, type CheckInput } from "./model.mts";
import { firing, START, WINDOW } from "./rule-helpers.mts";
import type { JsonRecord } from "../browser-harness/json.mts";

/** A metrics source with rows but no CPU worth reporting, so only the rule under test can fire. */
const CALM = metrics([[START, 1]], [[START, 0]]);

function withLogs(
  events: readonly JsonRecord[],
  invocations: readonly JsonRecord[] = [],
): CheckInput {
  return input(WINDOW, { logs: logs(events, invocations), metrics: CALM });
}

function settled(
  index: number,
  spacingMs: number,
  durationMs: number,
  extra: JsonRecord = {},
): JsonRecord {
  return eventRow(START + index * spacingMs, "route.settled", {
    requestId: `req-${index}`,
    route: "/api/x",
    durationMs,
    ...extra,
  });
}

function calls(count: number, spacingMs: number, durationMs: number): readonly JsonRecord[] {
  return Array.from({ length: count }, (_, i) => settled(i, spacingMs, durationMs));
}

describe("rule a: slow-requests", () => {
  it("fires at 10 requests of 30 s in an hour, not at 9", () => {
    assert.deepEqual(firing(withLogs(calls(10, MINUTE_MS, 30_000))), ["slow-requests"]);
    assert.deepEqual(firing(withLogs(calls(9, MINUTE_MS, 30_000))), []);
  });

  it("does not count a request of 29.999 s", () => {
    assert.deepEqual(firing(withLogs(calls(10, MINUTE_MS, 29_999))), []);
  });

  it("does not count ten requests spread over more than an hour", () => {
    assert.deepEqual(firing(withLogs(calls(10, 7 * MINUTE_MS, 30_000))), []);
  });

  it("counts canceled invocations on owner routes, not on other paths", () => {
    const canceled = (path: string) =>
      Array.from({ length: 10 }, (_, i) =>
        canceledInvocationRow(START + i * MINUTE_MS, `c-${i}`, path, 50),
      );

    assert.deepEqual(firing(withLogs([], canceled("/api/projects"))), ["slow-requests"]);
    assert.deepEqual(firing(withLogs([], canceled("/assets/app.js"))), []);
  });

  it("does not count an invocation that was not canceled", () => {
    const completed = Array.from({ length: 10 }, (_, i) =>
      canceledInvocationRow(START + i * MINUTE_MS, `c-${i}`, "/api/x", 50, "ok"),
    );

    assert.deepEqual(firing(withLogs([], completed)), []);
  });
});

describe("rule b: poller", () => {
  const touching = (count: number): readonly JsonRecord[] =>
    Array.from({ length: count }, (_, i) =>
      eventRow(START + i * 3_000, "workspace.rpc", { requestId: `req-${i}`, durationMs: 10 }),
    );

  it("fires at 20 calls an hour when 10 touch the workspace, not at 19 calls or 9 touches", () => {
    assert.deepEqual(firing(withLogs([...calls(20, 90_000, 100), ...touching(10)])), ["poller"]);
    assert.deepEqual(firing(withLogs([...calls(19, 90_000, 100), ...touching(10)])), []);
    assert.deepEqual(firing(withLogs([...calls(20, 90_000, 100), ...touching(9)])), []);
  });

  it("fires on more than 10 percent canceled, not on exactly 10 percent", () => {
    const withCanceled = (canceled: number) =>
      withLogs(
        calls(20 - canceled, 90_000, 100),
        Array.from({ length: canceled }, (_, i) =>
          canceledInvocationRow(START + (30 + i) * MINUTE_MS, `c-${i}`, "/api/x", 50),
        ),
      );

    const rulesFor = (checked: CheckInput) => firing(checked).filter((rule) => rule === "poller");

    assert.deepEqual(rulesFor(withCanceled(3)), ["poller"]);
    assert.deepEqual(rulesFor(withCanceled(2)), []);
  });
});

describe("rule c: unowned-cpu", () => {
  const events = [
    eventRow(START, "route.settled", { requestId: "r", route: "/api/x", durationMs: 1 }),
  ];

  const cpuRun = (buckets: number, perBucket: number, owned?: number) =>
    input(WINDOW, {
      logs: logs(
        owned === undefined
          ? events
          : [
              ...events,
              eventRow(START + owned * BUCKET_MS + 1000, "workspace.exec", { durationMs: 1000 }),
            ],
      ),
      metrics: metrics(
        bucketsOf(
          { fromMs: START + BUCKET_MS, toMs: START + (buckets + 1) * BUCKET_MS },
          () => perBucket,
        ),
        [[START, 0]],
      ),
    });

  it("fires on 30 minutes of buckets above 30 CPU-s, not on 25 minutes or on exactly 30 CPU-s", () => {
    assert.deepEqual(firing(cpuRun(6, 31)), ["unowned-cpu"]);
    assert.deepEqual(firing(cpuRun(5, 31)), []);
    assert.deepEqual(firing(cpuRun(6, 30)), []);
  });

  it("is broken by a bucket that owner work overlaps", () => {
    assert.deepEqual(firing(cpuRun(6, 31, 3)), []);
  });
});

describe("rule e: fault events", () => {
  const closed = (running: boolean) =>
    eventRow(START + MINUTE_MS, "workspace.backend.closed", { level: "warn", running });

  const stopped = (level: string) =>
    eventRow(START + MINUTE_MS, "workspace.container.stopped", { level, reasonCode: "unknown" });

  it("fires on a close with running true, not running false or null", () => {
    assert.deepEqual(firing(withLogs([closed(true)])), ["running-close"]);
    assert.deepEqual(firing(withLogs([closed(false)])), []);
    assert.deepEqual(
      firing(
        withLogs([eventRow(START, "workspace.backend.closed", { level: "warn", running: null })]),
      ),
      [],
    );
  });

  it("fires on an unknown stop reason at warn or error, not at info", () => {
    assert.ok(firing(withLogs([stopped("warn")])).includes("unexplained-stop"));
    assert.ok(firing(withLogs([stopped("error")])).includes("unexplained-stop"));
    assert.deepEqual(firing(withLogs([stopped("info")])), []);
  });

  it("fires on any error-level event inside the window, not outside it", () => {
    assert.deepEqual(
      firing(withLogs([eventRow(START + MINUTE_MS, "turn.settled", { level: "error" })])),
      ["error-events"],
    );
    assert.deepEqual(
      firing(withLogs([eventRow(START - MINUTE_MS, "turn.settled", { level: "error" })])),
      [],
    );
  });
});

describe("rule f: unknown", () => {
  it("is reported when a query hit its row limit", () => {
    const rows = Array.from({ length: 2000 }, (_, i) => eventRow(START + i, "turn.admitted"));

    assert.deepEqual(firing(withLogs(rows)), ["unknown"]);
  });

  it("is reported when CPU metrics are empty but usage has rows", () => {
    const checked = input(WINDOW, {
      logs: logs(calls(1, 1, 1)),
      metrics: metrics([], [[START, 0]]),
    });

    assert.deepEqual(firing(checked), ["unknown"]);
  });

  it("does not attribute container time from truncated logs", () => {
    const rows = Array.from({ length: 2000 }, (_, i) =>
      eventRow(START + i, "workspace.container.started"),
    );

    const busy = bucketsOf(
      { fromMs: START + 60 * MINUTE_MS, toMs: START + 120 * MINUTE_MS },
      () => 99,
    );

    assert.deepEqual(
      firing(input(WINDOW, { logs: logs(rows), metrics: metrics(busy, [[START, 0]]) })),
      ["unknown"],
    );
  });

  it("is reported when metrics have rows only for one dataset", () => {
    const checked = input(WINDOW, {
      logs: logs(calls(1, 1, 1)),
      metrics: metrics([[START, 1]], []),
    });

    assert.deepEqual(firing(checked), ["unknown"]);
  });

  it("is reported for a GraphQL error response, not read as zero", () => {
    const failed = {
      status: "unavailable",
      reason: "GraphQL response had errors or an unexpected shape",
    } as const;

    assert.deepEqual(firing({ ...withLogs(calls(1, 1, 1)), metrics: failed }), ["unknown"]);
  });
});
