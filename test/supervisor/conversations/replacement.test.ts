import * as Effect from "effect/Effect";
import { expect, test, vi } from "vitest";
import { GENERATION_REPLACED } from "../../../src/generation-replaced.js";
import { GenerationHostTarget } from "../../../src/supervisor/conversations/host-target.js";
import { HeldWorkspaces } from "../../../src/supervisor/conversations/held-workspaces.js";
import { HARNESS_PROJECT } from "../../../src/selectable-projects.js";

function trackedWorkspaces() {
  const signals: AbortSignal[] = [];

  const held = new HeldWorkspaces((_project, _remaining, signal) => {
    signals.push(signal);

    return Effect.succeed(null);
  });

  return { held, aborted: () => signals.map((signal) => signal.aborted) };
}

function hold(held: HeldWorkspaces, conversationId: string) {
  held.capability(conversationId, HARNESS_PROJECT, 1000).catch(() => {});
}

test("a retirement ends the leases held when it began, not ones taken before it runs", () => {
  vi.useFakeTimers();

  const { held, aborted } = trackedWorkspaces();
  const abortFacet = vi.fn<() => void>();

  hold(held, "old");
  held.retire(abortFacet);
  hold(held, "new");
  vi.runAllTimers();

  expect(abortFacet).toHaveBeenCalledTimes(1);
  expect(aborted()).toEqual([true, false]);

  vi.useRealTimers();
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

  vi.useRealTimers();
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
