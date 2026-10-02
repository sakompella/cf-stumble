import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { expect, test } from "vitest";
import { decideIdleStop, type WorkspaceActivity } from "../../src/workspace/idle-stop.js";

const time = gs.integers({ minValue: 0, maxValue: 10_000_000 });

function drawActivity(tc: hegel.TestCase): WorkspaceActivity {
  return {
    inFlight: tc.draw(gs.integers({ minValue: 0, maxValue: 3 })),
    lastActiveAtMs: tc.draw(time),
    leaseEndsAtMs: tc.draw(gs.booleans()) ? tc.draw(time) : null,
  };
}

function idleSince(activity: WorkspaceActivity): number {
  return Math.max(activity.lastActiveAtMs, activity.leaseEndsAtMs ?? 0);
}

test("never stops while work is in flight", () => {
  hegel.test((tc) => {
    const activity = {
      ...drawActivity(tc),
      inFlight: tc.draw(gs.integers({ minValue: 1, maxValue: 5 })),
    };

    const decision = decideIdleStop(
      activity,
      tc.draw(time),
      tc.draw(gs.integers({ minValue: 1, maxValue: 100_000 })),
    );

    expect(decision.kind).toBe("check-at");
  });
});

test("never stops before the limit, and always stops from the moment it passes", () => {
  hegel.test((tc) => {
    const activity = { ...drawActivity(tc), inFlight: 0 };
    const limit = tc.draw(gs.integers({ minValue: 1, maxValue: 100_000 }));
    const now = tc.draw(time);

    const decision = decideIdleStop(activity, now, limit);
    const idleFor = now - idleSince(activity);

    expect(decision.kind).toBe(idleFor >= limit ? "stop" : "check-at");

    if (decision.kind === "stop") expect(decision.idleForMs).toBe(idleFor);
  });
});

test("the next check is never in the past", () => {
  hegel.test((tc) => {
    const activity = drawActivity(tc);
    const now = tc.draw(time);

    const decision = decideIdleStop(
      activity,
      now,
      tc.draw(gs.integers({ minValue: 1, maxValue: 100_000 })),
    );

    if (decision.kind === "check-at") expect(decision.atMs).toBeGreaterThan(now);
  });
});
