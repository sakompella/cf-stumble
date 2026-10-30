/// <reference types="@cloudflare/vitest-plugin/types" />

import { runInDurableObject, reset } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import { ProjectThreads } from "../../../src/supervisor/threads/index.js";
import { PROJECT_TURN_LEASE_MS } from "../../../src/turn-budget.js";
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

test("a previous instance's lease blocks neither a fresh thread, a reset nor a disconnect", async () => {
  const control = await supervisor("turn-lease-previous-instance-free");

  const observed = await runInDurableObject(control, (_instance, state) => {
    threadsOf(state, "instance-a").startTurn("sample-project-one", 0, NOW, PROJECT_TURN_LEASE_MS);
    const restarted = threadsOf(state, "instance-b");

    return {
      liveTurn: restarted.liveTurn(NOW),
      fresh: restarted.startFreshThread("sample-project-one", NOW),
      disconnected: restarted.disconnectProject("sample-project-one", NOW),
    };
  });

  expect(observed).toMatchObject({
    liveTurn: undefined,
    fresh: { ok: true },
    disconnected: { ok: true },
  });
});
