import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { expect, test } from "vitest";
import {
  nextProviderState,
  type ProviderContainerEvent,
  type ProviderContainerState,
} from "../../src/workspace/provider-state.js";

const RUNTIMES = ["runtime-a", "runtime-b", "runtime-c"];

const exit = { exitedAt: 1, reason: "exited 137" };

const event = gs.oneOf<ProviderContainerEvent>(
  gs.sampledFrom(RUNTIMES).map((runtime) => ({ _tag: "started", runtime })),
  gs.just({ _tag: "stopped" }),
  gs.sampledFrom(RUNTIMES).map((runtime) => ({ _tag: "exited", runtime, exit })),
  gs.just({ _tag: "disconnected", exit }),
);

function liveRuntime(events: readonly ProviderContainerEvent[]): string | undefined {
  let live: string | undefined;

  for (const next of events) {
    if (next._tag === "started") live = next.runtime;
    else if (next._tag !== "exited" || next.runtime === live) live = undefined;
  }

  return live;
}

test("the container runs exactly while the latest start has not been stopped, lost, or reported exited", () => {
  hegel.test(
    (tc) => {
      const events = tc.draw(gs.arrays(event, { maxSize: 30 }));
      const initial: ProviderContainerState = { _tag: "stopped", exit: null };
      const state = events.reduce(nextProviderState, initial);
      const live = liveRuntime(events);

      expect(state._tag === "running" ? state.runtime : undefined).toBe(live);
    },
    { testCases: 2_000 },
  );
});

test("an exit report for an older launch never stops the current one", () => {
  hegel.test((tc) => {
    const [current, older] = tc.draw(gs.sampledFrom([RUNTIMES, RUNTIMES.toReversed()]));
    const running: ProviderContainerState = { _tag: "running", runtime: current ?? "" };

    expect(nextProviderState(running, { _tag: "exited", runtime: older ?? "", exit })).toBe(
      running,
    );
  });
});
