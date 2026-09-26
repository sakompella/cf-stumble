/// <reference types="@cloudflare/vitest-plugin/types" />

import { runInDurableObject, reset } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import { runProjectTurn } from "../../../src/supervisor/projects/index.js";
import { ProjectThreads } from "../../../src/supervisor/threads/index.js";
import { PROJECT_TURN_LEASE_MS } from "../../../src/turn-budget.js";
import { capturedEvents, named } from "../../log-capture.js";
import { sampleSelectableCatalog } from "../../project-fixtures.js";
import { connectedSupervisor as supervisor } from "../helpers.js";

const NOW = 1_700_000_000_000;

function threadsOf(state: DurableObjectState, holderId: string): ProjectThreads {
  return new ProjectThreads(state.storage, () => sampleSelectableCatalog, holderId);
}

afterEach(async () => {
  await reset();
});

test("a different Supervisor instance reclaims an active lease immediately", async () => {
  const control = await supervisor("turn-lease-previous-instance");

  const started = await runInDurableObject(control, (_instance, state) => {
    const first = threadsOf(state, "instance-a");
    const second = threadsOf(state, "instance-b");

    expect(first.startTurn("sample-project-one", 0, NOW, PROJECT_TURN_LEASE_MS)).toMatchObject({
      ok: true,
    });

    return second.startTurn("sample-project-one", 0, NOW, PROJECT_TURN_LEASE_MS);
  });

  expect(started).toMatchObject({ ok: true, reclaimed: true });
});

test("reclaiming a previous instance lease is logged with its lease suffix", async () => {
  const events = capturedEvents();
  const control = await supervisor("turn-lease-reclaim-log");

  await runInDurableObject(control, (_instance, state) => {
    const first = threadsOf(state, "instance-a");
    const second = threadsOf(state, "instance-b");
    first.startTurn("sample-project-one", 0, NOW, PROJECT_TURN_LEASE_MS);

    return runProjectTurn({
      projectId: "sample-project-one",
      prompt: "do the work",
      threads: second,
      attribution: () => ({
        active: { generation: undefined, epoch: 0, activationId: undefined },
      }),
      start: () => Promise.resolve({ ok: false, reason: "workspace-unavailable" as const }),
      now: () => NOW,
      leaseMs: PROJECT_TURN_LEASE_MS,
      deadlineMs: PROJECT_TURN_LEASE_MS,
    });
  });

  const [reclaimed] = named(events(), "turn.lease-reclaimed");
  expect(reclaimed).toMatchObject({ level: "warn", why: "previous-instance" });
  expect(String(reclaimed?.lease)).toHaveLength(8);
});

test("the same Supervisor instance still gets a turn conflict", async () => {
  const control = await supervisor("turn-lease-same-instance");

  const result = await runInDurableObject(control, (_instance, state) => {
    const threads = threadsOf(state, "instance-a");
    threads.startTurn("sample-project-one", 0, NOW, PROJECT_TURN_LEASE_MS);

    return threads.startTurn("sample-project-one", 0, NOW, PROJECT_TURN_LEASE_MS);
  });

  expect(result).toEqual({
    ok: false,
    problem: {
      code: "turn-conflict",
      projectId: "sample-project-one",
      deadlineAt: NOW + PROJECT_TURN_LEASE_MS,
    },
  });
});
