import * as Effect from "effect/Effect";
import { afterEach, expect, test, vi } from "vitest";
import { GENERATION_REPLACED } from "../../../src/generation-replaced.js";
import {
  GenerationHostTarget,
  servingHosts,
} from "../../../src/supervisor/conversations/host-target.js";
import { HeldWorkspaces } from "../../../src/supervisor/conversations/held-workspaces.js";
import { HARNESS_PROJECT } from "../../../src/selectable-projects.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function trackedWorkspaces() {
  const released: boolean[] = [];

  const held = new HeldWorkspaces(() => {
    const index = released.push(false) - 1;

    return Effect.never.pipe(
      Effect.onInterrupt(() =>
        Effect.sync(() => {
          released[index] = true;
        }),
      ),
    );
  });

  return { held, aborted: () => [...released] };
}

function hold(held: HeldWorkspaces, conversationId: string) {
  held.capability(conversationId, HARNESS_PROJECT, 1000).catch(() => {});
}

test("a retirement ends the leases held when it began, not ones taken before it runs", async () => {
  vi.useFakeTimers();

  const { held, aborted } = trackedWorkspaces();
  const abortFacet = vi.fn<() => void>();

  try {
    hold(held, "old");
    held.retire(abortFacet);
    hold(held, "new");
    await vi.runAllTimersAsync();

    expect(abortFacet).toHaveBeenCalledTimes(1);
    expect(aborted()).toEqual([true, false]);
  } finally {
    held.endAll();
  }
});

test("a retirement runs at once, and only once, when the next mount flushes it", () => {
  vi.useFakeTimers();

  const { held } = trackedWorkspaces();
  const abortFacet = vi.fn<() => void>();

  held.retire(abortFacet);
  held.flushRetirement();
  expect(abortFacet).toHaveBeenCalledTimes(1);

  vi.runAllTimers();
  expect(abortFacet).toHaveBeenCalledTimes(1);
});

test("a replaced serving instance's generation host refuses every call without reaching the Supervisor", async () => {
  const reached = vi.fn<() => never>();

  const host = new GenerationHostTarget(
    {
      getActiveGeneration: reached,
      submitGeneration: reached,
      prepareGeneration: reached,
      controlGeneration: reached,
    },
    () => false,
  );

  await expect(host.generationStatus()).rejects.toThrow(GENERATION_REPLACED);
  await expect(host.submitGeneration({})).rejects.toThrow(GENERATION_REPLACED);
  await expect(host.prepareGeneration(1)).rejects.toThrow(GENERATION_REPLACED);
  await expect(host.controlGeneration({})).rejects.toThrow(GENERATION_REPLACED);
  expect(reached).not.toHaveBeenCalled();
});

test("a replaced serving instance's run reports and wakes are refused without reaching the Supervisor", async () => {
  const reached = vi.fn<() => never>();

  const { host } = servingHosts(
    { arm: reached, log: reached, running: reached, workspace: reached },
    {
      getActiveGeneration: reached,
      submitGeneration: reached,
      prepareGeneration: reached,
      controlGeneration: reached,
    },
    () => false,
  );

  await expect(host.running([], { conversation: "faulted" })).rejects.toThrow(GENERATION_REPLACED);
  await expect(host.arm({ active: true })).rejects.toThrow(GENERATION_REPLACED);
  expect(reached).not.toHaveBeenCalled();
});
