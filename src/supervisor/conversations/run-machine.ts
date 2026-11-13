import * as Data from "effect/Data";
import * as Schema from "effect/Schema";
import type { RunningConversation } from "../../facet/index.js";
import { PROJECT_RUN_DEADLINE_MS } from "../../turn-budget.js";

const Ending = Schema.Literals(["cancelled", "interrupted"]);

export type RunEnding = typeof Ending.Type;

const runFields = {
  run: Schema.NullOr(Schema.Number),
  deadline: Schema.Number,
  instance: Schema.NullOr(Schema.Number),
  continues: Schema.Number,
};

export const RunState = Schema.TaggedUnion({
  Idle: {},
  Running: runFields,
  Ending: { ...runFields, ending: Ending },
});

export type RunState = typeof RunState.Type;

export type ActiveRun = Exclude<RunState, { readonly _tag: "Idle" }>;

export type RunOutcome =
  | "completed"
  | "failed"
  | "interrupted"
  | "stalled"
  | "cancelled"
  | "unanswered"
  | "replaced";

export type RunEvent = Data.TaggedEnum<{
  Reported: {
    readonly report: RunningConversation | undefined;
    readonly errorCode: string | null;
    readonly instance: number;
    readonly now: number;
    readonly modelTurnAt: number | null;
    readonly supervisorStartedAt: number;
  };
  Ended: { readonly ending: RunEnding };
}>;

export const RunEvent = Data.taggedEnum<RunEvent>();

type Reported = Extract<RunEvent, { readonly _tag: "Reported" }>;

export type RunCommand = Data.TaggedEnum<{
  Started: { readonly deadline: number };
  Settled: {
    readonly outcome: RunOutcome;
    readonly errorCode: string | null;
    readonly deadline: number;
    readonly continues: number;
  };
}>;

export const RunCommand = Data.taggedEnum<RunCommand>();

export type RunStep = Readonly<{ state: RunState; commands: readonly RunCommand[] }>;

const GENERATION_FAULTS: ReadonlySet<string> = new Set([
  "faulted",
  "orphaned",
  "restart_limit",
  "session-failed",
]);

function answered(errorCode: string | null): RunOutcome {
  if (errorCode === null) return "completed";

  return GENERATION_FAULTS.has(errorCode) ? "failed" : "unanswered";
}

function stay(state: RunState): RunStep {
  return { state, commands: [] };
}

function started({ report, instance, now }: Reported & { report: RunningConversation }): RunStep {
  const deadline = now + PROJECT_RUN_DEADLINE_MS;

  return {
    state: RunState.cases.Running.make({
      run: report.run ?? null,
      deadline,
      instance,
      continues: report.continues ?? 0,
    }),
    commands: [RunCommand.Started({ deadline })],
  };
}

function continues(active: ActiveRun, report: RunningConversation): boolean {
  return report.run === undefined || active.run === null || report.run === active.run;
}

function adopted(active: ActiveRun, report: RunningConversation, event: Reported): RunState {
  const { instance, now } = event;
  const run = active.run ?? report.run ?? null;

  if (RunState.guards.Running(active) && active.instance !== null && active.instance !== instance) {
    return RunState.cases.Running.make({
      run,
      deadline: now + PROJECT_RUN_DEADLINE_MS,
      instance,
      continues: active.continues,
    });
  }

  const fields = {
    run,
    deadline: active.deadline,
    instance: active.instance ?? instance,
    continues: active.continues,
  };

  return RunState.guards.Ending(active)
    ? RunState.cases.Ending.make({ ...fields, ending: active.ending })
    : RunState.cases.Running.make(fields);
}

function deadlineOutcome(
  active: ActiveRun,
  { modelTurnAt, supervisorStartedAt }: Reported,
): RunOutcome {
  const startedAt = active.deadline - PROJECT_RUN_DEADLINE_MS;
  const askedModel = modelTurnAt !== null && modelTurnAt >= startedAt;

  return askedModel || supervisorStartedAt > startedAt ? "interrupted" : "stalled";
}

function reportedOn(active: ActiveRun, event: Reported, outcome: RunOutcome): RunStep {
  const { report, errorCode, instance } = event;

  if (report !== undefined && continues(active, report)) {
    return stay(adopted(active, report, event));
  }

  const owned = active.instance === null || active.instance === instance;

  const settled = RunCommand.Settled({
    outcome: owned ? outcome : "replaced",
    errorCode,
    deadline: active.deadline,
    continues: active.continues,
  });

  if (report === undefined) return { state: RunState.cases.Idle.make({}), commands: [settled] };

  const next = started({ ...event, report });

  return { state: next.state, commands: [settled, ...next.commands] };
}

export function transition(state: RunState, event: RunEvent): RunStep {
  return RunState.match(state, {
    Idle: () =>
      RunEvent.$match(event, {
        Reported: (reported) =>
          reported.report === undefined
            ? stay(state)
            : started({ ...reported, report: reported.report }),
        Ended: () => stay(state),
      }),
    Running: (running) =>
      RunEvent.$match(event, {
        Reported: (reported) => reportedOn(running, reported, answered(reported.errorCode)),
        Ended: ({ ending }) =>
          stay(
            RunState.cases.Ending.make({
              run: running.run,
              deadline: running.deadline,
              instance: running.instance,
              continues: running.continues,
              ending,
            }),
          ),
      }),
    Ending: (ending) =>
      RunEvent.$match(event, {
        Reported: (reported) =>
          reportedOn(
            ending,
            reported,
            ending.ending === "interrupted" ? deadlineOutcome(ending, reported) : ending.ending,
          ),
        Ended: () => stay(state),
      }),
  });
}
