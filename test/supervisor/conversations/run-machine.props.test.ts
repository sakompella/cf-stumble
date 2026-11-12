import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { expect, test } from "vitest";
import {
  RunEvent,
  RunState,
  transition,
  type RunCommand,
  type RunEnding,
  type RunOutcome,
} from "../../../src/supervisor/conversations/run-machine.js";
import { PROJECT_RUN_DEADLINE_MS } from "../../../src/turn-budget.js";

type Open = {
  run: number | null;
  deadline: number;
  instance: number | null;
  ending: RunEnding | null;
};

type World = {
  state: RunState;
  now: number;
  open: Open | null;
  unsettled: boolean;
};

type View = Open | null;

type Seen = Readonly<{ run: number | undefined }>;

type Expected = Readonly<{ next: Open | null; commands: RunCommand[] }>;

type Signs = Readonly<{ modelTurnAt: number | null; supervisorStartedAt: number }>;

const GENERATION_FAULTS = ["faulted", "orphaned", "restart_limit", "session-failed"];

const OTHER_REASONS = ["model_error", "no_model", "aborted"];

const errorCode = gs.oneOf(
  gs.just(null),
  gs.sampledFrom([...GENERATION_FAULTS, ...OTHER_REASONS]),
  gs.text({ maxSize: 6 }),
);

const run = gs.optional(gs.integers({ minValue: 0, maxValue: 2 })).map((id) => id ?? undefined);

const instance = gs.integers({ minValue: 0, maxValue: 2 });

const nearStart = gs.sampledFrom([-1, 0, 1]);

const ending = gs.sampledFrom(["cancelled", "interrupted"] as const);

function answeredOutcome(code: string | null): RunOutcome {
  if (code === null) return "completed";

  return GENERATION_FAULTS.includes(code) ? "failed" : "unanswered";
}

function view(state: RunState): View {
  if (state._tag === "Idle") return null;

  return {
    run: state.run,
    deadline: state.deadline,
    instance: state.instance,
    ending: state._tag === "Ending" ? state.ending : null,
  };
}

function endedOutcome(open: Open, code: string | null, signs: Signs): RunOutcome {
  if (open.ending === null) return answeredOutcome(code);

  if (open.ending === "cancelled") return "cancelled";

  const startedAt = open.deadline - PROJECT_RUN_DEADLINE_MS;
  const askedModel = signs.modelTurnAt !== null && signs.modelTurnAt >= startedAt;

  return askedModel || signs.supervisorStartedAt > startedAt ? "interrupted" : "stalled";
}

function expectedReport(
  open: Open | null,
  report: Seen | null,
  code: string | null,
  by: number,
  now: number,
  signs: Signs,
): Expected {
  const commands: RunCommand[] = [];

  const continuing =
    open !== null &&
    report !== null &&
    (report.run === undefined || open.run === null || report.run === open.run);

  if (continuing) {
    const kept = open.run ?? report.run ?? null;
    const takenOver = open.ending === null && open.instance !== null && open.instance !== by;

    return {
      next: takenOver
        ? { run: kept, deadline: now + PROJECT_RUN_DEADLINE_MS, instance: by, ending: null }
        : { ...open, run: kept, instance: open.instance ?? by },
      commands,
    };
  }

  if (open !== null) {
    const ours = open.instance === null || open.instance === by;
    const outcome = ours ? endedOutcome(open, code, signs) : "replaced";

    commands.push({ _tag: "Settled", outcome, errorCode: code, deadline: open.deadline });
  }

  if (report === null) return { next: null, commands };

  const deadline = now + PROJECT_RUN_DEADLINE_MS;

  commands.push({ _tag: "Started", deadline });

  return { next: { run: report.run ?? null, deadline, instance: by, ending: null }, commands };
}

function apply(world: World, event: RunEvent, expected: Expected) {
  const step = transition(world.state, event);

  expect(step.commands).toEqual(expected.commands);
  expect(view(step.state)).toEqual(expected.next);

  for (const command of step.commands) {
    if (command._tag === "Settled") {
      expect(world.unsettled).toBe(true);
      world.unsettled = false;
    } else {
      expect(world.unsettled).toBe(false);
      world.unsettled = true;
    }
  }

  expect(step.state._tag === "Idle").toBe(!world.unsettled);

  world.state = step.state;
  world.open = expected.next;
}

function reported(tc: hegel.TestCase, world: World, seen: Seen | null) {
  world.now += tc.draw(gs.integers({ minValue: 0, maxValue: 2 * PROJECT_RUN_DEADLINE_MS }));

  const code = tc.draw(errorCode);
  const by = tc.draw(instance);
  const report = seen === null ? undefined : { conversationId: "c", run: seen.run };

  const startedAt = (world.open?.deadline ?? world.now) - PROJECT_RUN_DEADLINE_MS;
  const modelTurn = tc.draw(gs.optional(nearStart)) ?? null;

  const signs = {
    modelTurnAt: modelTurn === null ? null : startedAt + modelTurn,
    supervisorStartedAt: startedAt + tc.draw(nearStart),
  };

  apply(
    world,
    RunEvent.Reported({ report, errorCode: code, instance: by, now: world.now, ...signs }),
    expectedReport(world.open, seen, code, by, world.now, signs),
  );
}

const machine: hegel.stateful.StateMachine<World> = {
  rules: {
    stillRunning: (tc, world) => {
      reported(tc, world, { run: tc.draw(run) });
    },
    nothingRunning: (tc, world) => {
      reported(tc, world, null);
    },
    ended: (tc, world) => {
      const by = tc.draw(ending);

      apply(world, RunEvent.Ended({ ending: by }), {
        next: world.open === null ? null : { ...world.open, ending: world.open.ending ?? by },
        commands: [],
      });
    },
  },
};

const initial = gs.composite<World>((tc) => {
  const fields = {
    run: tc.draw(gs.optional(gs.integers({ minValue: 0, maxValue: 2 }))),
    deadline: tc.draw(gs.integers({ minValue: 0, maxValue: 2 * PROJECT_RUN_DEADLINE_MS })),
    instance: tc.draw(gs.optional(instance)),
  };

  const kind = tc.draw(gs.sampledFrom(["Idle", "Running", "Ending"] as const));
  const by = tc.draw(ending);

  const [state, open]: [RunState, Open | null] =
    kind === "Idle"
      ? [RunState.cases.Idle.make({}), null]
      : kind === "Running"
        ? [RunState.cases.Running.make(fields), { ...fields, ending: null }]
        : [RunState.cases.Ending.make({ ...fields, ending: by }), { ...fields, ending: by }];

  return { state, now: 0, open, unsettled: open !== null };
});

test("a run settles exactly once before the next starts, whatever the facet reports and however it is ended", () => {
  hegel.test((tc) => {
    hegel.stateful.run(tc, machine, tc.draw(initial), { stepCount: 30 });
  });
});

test("a run aborted at its deadline is stalled only when its instance asked no model turn since it started and the Supervisor did not restart", () => {
  hegel.test((tc) => {
    const startedAt = tc.draw(gs.integers({ minValue: 0, maxValue: PROJECT_RUN_DEADLINE_MS }));
    const by = tc.draw(instance);
    const modelTurn = tc.draw(gs.optional(gs.integers({ minValue: -2, maxValue: 2 }))) ?? null;
    const restart = tc.draw(gs.integers({ minValue: -2, maxValue: 2 }));

    const signs = {
      modelTurnAt: modelTurn === null ? null : startedAt + modelTurn,
      supervisorStartedAt: startedAt + restart,
    };

    const running = transition(
      RunState.cases.Idle.make({}),
      RunEvent.Reported({
        report: { conversationId: "c" },
        errorCode: null,
        instance: by,
        now: startedAt,
        ...signs,
      }),
    ).state;

    const aborted = transition(running, RunEvent.Ended({ ending: "interrupted" })).state;
    const now = startedAt + PROJECT_RUN_DEADLINE_MS;

    const { commands } = transition(
      aborted,
      RunEvent.Reported({ report: undefined, errorCode: null, instance: by, now, ...signs }),
    );

    const stalled = (modelTurn === null || modelTurn < 0) && restart <= 0;

    expect(commands).toEqual([
      {
        _tag: "Settled",
        outcome: stalled ? "stalled" : "interrupted",
        errorCode: null,
        deadline: now,
      },
    ]);
  });
});
