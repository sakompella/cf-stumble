import { expect, test } from "vitest";
import { decideIdleStop, WORKSPACE_IDLE_STOP_MS } from "../../src/workspace/idle-stop.js";

const LIMIT = 10_000;

const idle = { inFlight: 0, lastActiveAtMs: 1_000, leaseEndsAtMs: null } as const;

test("the limit is ten minutes", () => {
  expect(WORKSPACE_IDLE_STOP_MS).toBe(600_000);
});

test.each([
  ["just after the last work", 1_001, { kind: "check-at", atMs: 11_000 }],
  ["one millisecond before the limit", 10_999, { kind: "check-at", atMs: 11_000 }],
  ["exactly at the limit", 11_000, { kind: "stop", idleForMs: 10_000 }],
  ["well past the limit", 31_000, { kind: "stop", idleForMs: 30_000 }],
] as const)("%s", (_name, nowMs, expected) => {
  expect(decideIdleStop(idle, nowMs, LIMIT)).toEqual(expected);
});

test("work in flight never stops, however long ago the last activity was", () => {
  expect(decideIdleStop({ ...idle, inFlight: 1 }, 1_000_000, LIMIT)).toEqual({
    kind: "check-at",
    atMs: 1_010_000,
  });
});

test("a lease that ends after the last activity delays the stop", () => {
  const leased = { ...idle, leaseEndsAtMs: 5_000 };

  expect(decideIdleStop(leased, 11_000, LIMIT)).toEqual({ kind: "check-at", atMs: 15_000 });
  expect(decideIdleStop(leased, 15_000, LIMIT)).toEqual({ kind: "stop", idleForMs: 10_000 });
});

test("a lease that ended before the last activity changes nothing", () => {
  expect(decideIdleStop({ ...idle, leaseEndsAtMs: 200 }, 11_000, LIMIT)).toEqual({
    kind: "stop",
    idleForMs: 10_000,
  });
});
