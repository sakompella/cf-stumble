/** Rule d: container time past the idle limit, from usage buckets and from the running instance. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runChecks } from "./check.mts";
import { bucketsOf, eventRow, input, logs, metrics } from "./fixtures.mts";
import { MINUTE_MS, type CheckInput, type TimeWindow } from "./model.mts";
import { firing, START, WINDOW } from "./rule-helpers.mts";

/** These tests probe the 20-minute boundary, so they say so instead of using the default. */
const TWENTY_MINUTES = 20 * MINUTE_MS;

function idleInput(window: TimeWindow, sources: Parameters<typeof input>[1]): CheckInput {
  return { ...input(window, sources), idleLimitMs: TWENTY_MINUTES };
}

describe("rule d: ran-past-idle", () => {
  const lastRequestAt = START + 60 * MINUTE_MS;

  const runningUntil = (minutes: number, idleLimitMs?: number): CheckInput => {
    const base = idleInput(WINDOW, {
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
    ...idleInput(
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

describe("rule d: the default idle limit", () => {
  const idleStopMs = 10 * MINUTE_MS;
  const lastRequest = START + 60 * MINUTE_MS;

  const runFor = (minutes: number): CheckInput =>
    input(WINDOW, {
      logs: logs([
        eventRow(lastRequest, "route.settled", {
          requestId: "r",
          route: "/api/projects",
          durationMs: 1,
        }),
      ]),
      metrics: metrics(
        [[START, 1]],
        bucketsOf({ fromMs: lastRequest, toMs: lastRequest + minutes * MINUTE_MS }, () => 5),
      ),
    });

  it("is the Host's idle stop, so a run past it plus the tolerance is reported", () => {
    assert.equal(runFor(5).idleLimitMs, idleStopMs);
    assert.deepEqual(firing(runFor(20)), []);
    assert.deepEqual(firing(runFor(25)), ["ran-past-idle"]);
  });
});

describe("rule d: overlapping instances", () => {
  it("does not count the second of two overlapping instances as excess", () => {
    const lastRequest = START + 60 * MINUTE_MS;

    const owned = bucketsOf(
      { fromMs: lastRequest, toMs: lastRequest + 20 * MINUTE_MS },
      () => 8.58,
    );

    const checked = idleInput(WINDOW, {
      logs: logs([
        eventRow(lastRequest, "route.settled", { requestId: "r", route: "/api/x", durationMs: 1 }),
      ]),
      metrics: metrics([[START, 1]], owned),
    });

    assert.deepEqual(firing(checked), []);
  });
});

describe("rule d: windows that end a few minutes ago", () => {
  const postWindow = (nowMs: number): CheckInput => ({
    ...runningAt(40, false, START),
    nowMs,
    instances: instanceSource(true, LAST_REQUEST_AT + 45 * MINUTE_MS),
  });

  it("does not use an instance that began after an explicit --to", () => {
    assert.deepEqual(firing(postWindow(LAST_REQUEST_AT + 45 * MINUTE_MS)), []);
  });

  it("ignores an instance that began running after the window end even when live", () => {
    const live = {
      ...runningAt(40, false, START),
      nowMs: LAST_REQUEST_AT + 40 * MINUTE_MS + 30_000,
    };

    assert.deepEqual(
      firing({
        ...live,
        instances: instanceSource(true, LAST_REQUEST_AT + 40 * MINUTE_MS + 10_000),
      }),
      [],
    );
  });

  it("does not report an instances failure for a --to five minutes ago", () => {
    const failed = { status: "unavailable", reason: "HTTP 403" } as const;

    assert.deepEqual(
      firing({ ...postWindow(LAST_REQUEST_AT + 45 * MINUTE_MS), instances: failed }),
      [],
    );
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
