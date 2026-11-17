import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import * as Schema from "effect/Schema";
import { expect, test } from "vitest";
import {
  lifecycleStep,
  LifecycleCommand,
  LifecycleEvent,
  ProjectState,
} from "../../../src/supervisor/projects/project-lifecycle-machine.js";

type State = ProjectState | undefined;

type Tag = LifecycleEvent["_tag"];

type Expected = Readonly<{ state: State; commands: readonly LifecycleCommand[] }>;

const EVENTS: readonly LifecycleEvent[] = Object.values(LifecycleEvent.cases).map((variant) =>
  variant.make({}),
);

const TAGS: readonly Tag[] = EVENTS.map((event) => event._tag);

const STATES: readonly State[] = [undefined, "provisioning", "connected", "removing"];

const tagged = (tag: Tag): LifecycleEvent => LifecycleEvent.cases[tag].make({});

const unchanged = (state: State): Expected => ({ state, commands: [] });

const removal = (): Expected => ({
  state: "removing",
  commands: [LifecycleCommand.RemoveDirectories()],
});

const TABLE: Readonly<Record<Tag, (state: State) => Expected>> = {
  connect: (state) =>
    state === "connected" || state === "removing"
      ? unchanged(state)
      : { state: "provisioning", commands: [LifecycleCommand.Provision()] },
  provisioned: (state) => unchanged(state === "provisioning" ? "connected" : state),
  provisionFailed: (state) => (state === "provisioning" ? removal() : unchanged(state)),
  disconnect: (state) => (state === undefined ? unchanged(state) : removal()),
  removed: (state) => unchanged(state === "removing" ? undefined : state),
  removalFailed: unchanged,
};

function walkFromNothing(tc: hegel.TestCase): State {
  return finish(undefined, tc.draw(gs.arrays(gs.sampledFrom(TAGS), { maxSize: 30 })));
}

const CONNECT_AFTER_REMOVAL: readonly Tag[] = ["removed", "connect", "provisioned"];

function finish(from: State, tags: readonly Tag[]): State {
  return tags.reduce<State>((state, tag) => lifecycleStep(state, tagged(tag)).state, from);
}

test("every state and event pair moves and emits like the documented transition table", () => {
  for (const state of STATES) {
    for (const tag of TAGS) expect(lifecycleStep(state, tagged(tag))).toEqual(TABLE[tag](state));
  }
});

test("a disconnect then a successful removal ends with no project from every reachable state", () => {
  hegel.test((tc) => {
    expect(finish(walkFromNothing(tc), ["disconnect", "removed"])).toBeUndefined();
  });
});

test("a connect then a successful provision ends connected from every reachable state once a pending removal finishes, and stays connected", () => {
  hegel.test((tc) => {
    const connected = finish(walkFromNothing(tc), CONNECT_AFTER_REMOVAL);

    expect(connected).toBe("connected");
    expect(lifecycleStep(connected, tagged("connect"))).toEqual(unchanged("connected"));
  });
});

test("a failed removal keeps the project in removing until a removal succeeds, and each disconnect asks for another", () => {
  hegel.test((tc) => {
    const failures = tc.draw(gs.integers({ minValue: 1, maxValue: 5 }));
    const connected = finish(walkFromNothing(tc), CONNECT_AFTER_REMOVAL);
    let step = lifecycleStep(connected, tagged("disconnect"));

    for (let attempt = 0; attempt < failures; attempt += 1) {
      step = lifecycleStep(step.state, tagged("removalFailed"));
      expect(step.state).toBe("removing");

      step = lifecycleStep(step.state, tagged("disconnect"));
      expect(step).toEqual(removal());
    }

    expect(lifecycleStep(step.state, tagged("removed")).state).toBeUndefined();
  });
});

test("a stored state decodes only when it is one of the three lifecycle states", () => {
  hegel.test((tc) => {
    const stored = tc.draw(
      gs.oneOf(gs.sampledFrom(["provisioning", "connected", "removing"]), gs.text()),
    );

    const decoded = Schema.decodeUnknownExit(ProjectState)(stored);
    const known = STATES.some((state) => state === stored);

    expect(decoded._tag).toBe(known ? "Success" : "Failure");
  });
});
