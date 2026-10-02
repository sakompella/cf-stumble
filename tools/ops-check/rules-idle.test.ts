/** Rule d: container time past the idle limit, from usage buckets and from the running instance. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runChecks } from "./check.mts";
import { bucketsOf, eventRow, input, logs, metrics } from "./fixtures.mts";
import { MINUTE_MS, type CheckInput } from "./model.mts";
import { firing, START, WINDOW } from "./rule-helpers.mts";

describe("rule d: ran-past-idle", () => {
  const lastRequestAt = START + 60 * MINUTE_MS;

  const runningUntil = (minutes: number, idleLimitMs?: number): CheckInput => {
    const base = input(WINDOW, {
      logs: logs([
        eventRow(lastRequestAt, "route.settled", {
          requestId: "r",
          route: "/api/x",
          durationMs: 1,
        }),
      ]),
      metrics: metrics(
        [[START, 1]],
        bucketsOf({ fromMs: lastRequestAt, toMs: lastRequestAt + minutes * MINUTE_MS }, () => 5),
      ),
    });

    return idleLimitMs === undefined ? base : { ...base, idleLimitMs };
  };

  it("fires beyond the 20 min idle limit plus 10 min, not at the limit plus 10 min", () => {
    assert.deepEqual(firing(runningUntil(30)), []);
    assert.deepEqual(firing(runningUntil(35)), ["ran-past-idle"]);
  });

  it("takes the idle limit as a parameter", () => {
    assert.deepEqual(firing(runningUntil(35, 30 * MINUTE_MS)), []);
    assert.deepEqual(firing(runningUntil(25, 5 * MINUTE_MS)), ["ran-past-idle"]);
  });
});

const LAST_REQUEST_AT = START + 60 * MINUTE_MS;

function instanceSource(running: boolean, runningSinceMs: number): CheckInput["instances"] {
  return { status: "ok", data: running ? [{ id: "instance-0001", runningSinceMs }] : [] };
}

function runningAt(
  minutesAfterRequest: number,
  running: boolean,
  runningSinceMs: number,
): CheckInput {
  return {
    ...input(
      { fromMs: START, toMs: LAST_REQUEST_AT + minutesAfterRequest * MINUTE_MS },
      {
        logs: logs([
          eventRow(LAST_REQUEST_AT, "route.settled", {
            requestId: "r",
            route: "/api/x",
            durationMs: 1,
          }),
        ]),
        metrics: metrics([[START, 1]], [[START, 0]]),
        nowMs: LAST_REQUEST_AT + minutesAfterRequest * MINUTE_MS,
      },
    ),
    instances: instanceSource(running, runningSinceMs),
  };
}

describe("rule d: running now and metrics lag", () => {
  it("fires when the instances API shows a running instance with no owner for too long", () => {
    assert.deepEqual(firing(runningAt(40, true, START)), ["ran-past-idle"]);
  });

  it("is quiet for an instance that is not running, because the newest metrics are incomplete", () => {
    assert.deepEqual(firing(runningAt(40, false, START)), []);
  });

  it("is quiet when the instance entered running with the request and is within the idle limit", () => {
    assert.deepEqual(firing(runningAt(25, true, LAST_REQUEST_AT)), []);
  });

  it("counts from when the instance entered running, not from when it was created", () => {
    assert.deepEqual(firing(runningAt(25, true, LAST_REQUEST_AT - 5 * MINUTE_MS)), []);
  });

  it("ignores usage buckets still inside the lag, which can be partial", () => {
    const partial = bucketsOf(
      { fromMs: LAST_REQUEST_AT + 25 * MINUTE_MS, toMs: LAST_REQUEST_AT + 40 * MINUTE_MS },
      () => 5,
    );

    const lagged = runningAt(40, false, START);

    assert.deepEqual(firing({ ...lagged, metrics: metrics([[START, 1]], partial) }), []);
  });

  it("reports one finding, not two, when buckets and the instance describe the same run", () => {
    const run = bucketsOf(
      { fromMs: LAST_REQUEST_AT + 20 * MINUTE_MS, toMs: LAST_REQUEST_AT + 35 * MINUTE_MS },
      () => 5,
    );

    const checked = { ...runningAt(45, true, START), metrics: metrics([[START, 1]], run) };

    assert.equal(runChecks(checked).length, 1);
  });
});

describe("rule d: overlapping instances", () => {
  it("does not count the second of two overlapping instances as excess", () => {
    const lastRequest = START + 60 * MINUTE_MS;

    const owned = bucketsOf(
      { fromMs: lastRequest, toMs: lastRequest + 20 * MINUTE_MS },
      () => 8.58,
    );

    const checked = input(WINDOW, {
      logs: logs([
        eventRow(lastRequest, "route.settled", { requestId: "r", route: "/api/x", durationMs: 1 }),
      ]),
      metrics: metrics([[START, 1]], owned),
    });

    assert.deepEqual(firing(checked), []);
  });
});

describe("rule d: windows that ended in the past", () => {
  it("does not ask the instances API about a window that ended long ago", () => {
    const past = { ...runningAt(40, true, START), nowMs: LAST_REQUEST_AT + 400 * MINUTE_MS };

    assert.deepEqual(firing(past), []);
  });

  it("does not report an unreadable instances API for a window that ended long ago", () => {
    const failed = { status: "unavailable", reason: "HTTP 403" } as const;
    const past = { ...runningAt(40, true, START), nowMs: LAST_REQUEST_AT + 400 * MINUTE_MS };

    assert.deepEqual(firing({ ...past, instances: failed }), []);
  });

  it("trusts metrics up to the lag before now, not before the window end", () => {
    const run = bucketsOf(
      { fromMs: LAST_REQUEST_AT + 20 * MINUTE_MS, toMs: LAST_REQUEST_AT + 40 * MINUTE_MS },
      () => 5,
    );

    const past = { ...runningAt(40, false, START), nowMs: LAST_REQUEST_AT + 400 * MINUTE_MS };

    assert.deepEqual(firing({ ...past, metrics: metrics([[START, 1]], run) }), ["ran-past-idle"]);
  });

  it("reports an unreadable instances API as unknown", () => {
    const failed = { status: "unavailable", reason: "HTTP 403" } as const;

    assert.deepEqual(firing({ ...runningAt(40, true, START), instances: failed }), ["unknown"]);
  });
});
