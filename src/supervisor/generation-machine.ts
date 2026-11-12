import * as Data from "effect/Data";
import * as Schema from "effect/Schema";
import type { HarnessCommit } from "../harness-commit.js";
import type { RunOutcome } from "./conversations/index.js";
import {
  GenerationState,
  Serving,
  wireGeneration,
  type LabeledGeneration,
  type Selection,
} from "./generation-state.js";
import type {
  ActivationCommand,
  ControlProblemCode,
  Generation,
  GenerationActor,
  GenerationControlResult,
  GenerationLabel,
  PreparationOutcome,
  Submission,
} from "./generations.js";
import type { GenerationChange } from "./history/commits.js";

export type GenerationCommand = Data.TaggedEnum<{
  Changed: {
    readonly kind: GenerationChange["kind"];
    readonly actor: GenerationActor;
    readonly epoch: number;
    readonly label: GenerationLabel;
    readonly outcome: string | null;
    readonly errorCode: string | null;
  };
  ProbationFailed: {
    readonly label: GenerationLabel;
    readonly fallback: GenerationLabel;
    readonly outcome: RunOutcome;
    readonly errorCode: string | null;
    readonly refused: ControlProblemCode | null;
  };
}>;

export const GenerationCommand = Data.taggedEnum<GenerationCommand>();

export type Step<Reply> = Readonly<{
  selection?: Selection;
  generation?: LabeledGeneration;
  commands: readonly GenerationCommand[];
  reply: Reply;
}>;

export type PreparationReply = Readonly<{
  generation: Generation;
  epoch: number;
  effect: "recorded" | "no-op";
}>;

export type RollbackReply = Readonly<{ command: ActivationCommand; epoch: number }> | undefined;

type RunVerdict = "proves" | "fails" | "neutral";

const RUN_VERDICT: Readonly<Record<RunOutcome, RunVerdict>> = {
  completed: "proves",
  failed: "fails",
  interrupted: "neutral",
  stalled: "fails",
  cancelled: "neutral",
  unanswered: "neutral",
  replaced: "neutral",
};

const UNCHANGED: Step<RollbackReply> = { commands: [], reply: undefined };

function reply<Reply>(value: Reply): Step<Reply> {
  return { commands: [], reply: value };
}

function refused(code: ControlProblemCode): Step<GenerationControlResult> {
  return reply({ ok: false, problem: { code } });
}

function changed(
  kind: GenerationChange["kind"],
  actor: GenerationActor,
  epoch: number,
  label: GenerationLabel,
  outcome: string | null = null,
  errorCode: string | null = null,
): GenerationCommand {
  return GenerationCommand.Changed({ kind, actor, epoch, label, outcome, errorCode });
}

function servingAfter(serving: Serving, label: GenerationLabel): Serving {
  return Serving.match(serving, {
    Unproven: () => Serving.cases.Unproven.make({ active: label }),
    Proven: ({ active }) => Serving.cases.Probation.make({ active: label, fallback: active }),
    Probation: ({ fallback }) =>
      label === fallback
        ? Serving.cases.Proven.make({ active: label })
        : Serving.cases.Probation.make({ active: label, fallback }),
  });
}

function activated(
  selection: Selection,
  target: LabeledGeneration,
  command: ActivationCommand,
  compatibility: string,
  actor: GenerationActor,
): Step<GenerationControlResult> {
  const kind: "activated" | "rolled-back" =
    command.kind === "activate" ? "activated" : "rolled-back";

  if (selection.serving.active === target.label) {
    const outcome = { kind, generation: wireGeneration(target), epoch: selection.epoch };

    return reply({ ok: true, outcome: { ...outcome, effect: "no-op" } });
  }

  const generation = { ...target, state: GenerationState.cases.Served.make({ compatibility }) };
  const epoch = selection.epoch + 1;

  return {
    selection: { epoch, serving: servingAfter(selection.serving, target.label) },
    generation,
    commands: [changed(kind, actor, epoch, target.label)],
    reply: {
      ok: true,
      outcome: { kind, generation: wireGeneration(generation), epoch, effect: "activated" },
    },
  };
}

export function activation(
  selection: Selection,
  target: LabeledGeneration | undefined,
  command: ActivationCommand,
  compatibility: string,
  actor: GenerationActor,
): Step<GenerationControlResult> {
  if (command.observedEpoch !== selection.epoch) return refused("stale-epoch");

  if (target === undefined) return refused("unknown-generation");

  const ifCompatible = (recorded: string) =>
    recorded === compatibility
      ? activated(selection, target, command, compatibility, actor)
      : refused("facet-compatibility-mismatch");

  return GenerationState.match(target.state, {
    Candidate: () => refused("not-ready"),
    Failed: () => refused("not-ready"),
    Ready: (ready) =>
      command.kind === "rollback"
        ? refused("not-previously-active")
        : ifCompatible(ready.compatibility),
    Served: (served) => ifCompatible(served.compatibility),
  });
}

function rolledBack(
  selection: Selection,
  probation: Extract<Serving, { readonly _tag: "Probation" }>,
  target: LabeledGeneration | undefined,
  run: Readonly<{ outcome: RunOutcome; errorCode: string | null }>,
  compatibility: string,
): Step<RollbackReply> {
  const command = {
    kind: "rollback",
    label: probation.fallback,
    observedEpoch: selection.epoch,
  } as const;

  const rollback = activation(selection, target, command, compatibility, "probation");
  const { label, fallback } = { label: probation.active, fallback: probation.fallback };

  const failed = changed(
    "probation-failed",
    "probation",
    selection.epoch,
    label,
    run.outcome,
    run.errorCode,
  );

  if (!rollback.reply.ok) {
    const { code } = rollback.reply.problem;

    return {
      selection: { ...selection, serving: Serving.cases.Unproven.make({ active: label }) },
      commands: [
        failed,
        GenerationCommand.ProbationFailed({ label, fallback, ...run, refused: code }),
      ],
      reply: undefined,
    };
  }

  return {
    ...rollback,
    commands: [
      failed,
      ...rollback.commands,
      GenerationCommand.ProbationFailed({ label, fallback, ...run, refused: null }),
    ],
    reply: { command, epoch: rollback.reply.outcome.epoch },
  };
}

export function settlement(
  selection: Selection,
  fallback: LabeledGeneration | undefined,
  run: Readonly<{ outcome: RunOutcome; errorCode: string | null }>,
  compatibility: string,
): Step<RollbackReply> {
  const verdict = RUN_VERDICT[run.outcome];

  const proven = (active: GenerationLabel): Step<RollbackReply> => ({
    selection: { ...selection, serving: Serving.cases.Proven.make({ active }) },
    commands: [changed("proven", "probation", selection.epoch, active, run.outcome)],
    reply: undefined,
  });

  return Serving.match(selection.serving, {
    Unproven: ({ active }) =>
      active !== null && verdict === "proves" ? proven(active) : UNCHANGED,
    Proven: () => UNCHANGED,
    Probation: (probation) => {
      if (verdict === "neutral") return UNCHANGED;

      if (verdict === "proves") return proven(probation.active);

      return rolledBack(selection, probation, fallback, run, compatibility);
    },
  });
}

const sameState = Schema.toEquivalence(GenerationState);

export function preparation(
  selection: Selection,
  current: LabeledGeneration,
  outcome: PreparationOutcome,
  actor: GenerationActor,
): Step<PreparationReply> {
  const checked =
    outcome.status === "ready"
      ? GenerationState.cases.Ready.make({ compatibility: outcome.compatibility })
      : GenerationState.cases.Failed.make({});

  const state = GenerationState.match(current.state, {
    Candidate: () => checked,
    Failed: () => checked,
    Ready: () => checked,
    Served: (served) =>
      outcome.status === "ready"
        ? GenerationState.cases.Served.make({ compatibility: outcome.compatibility })
        : served,
  });

  if (sameState(state, current.state)) {
    return reply({ generation: wireGeneration(current), epoch: selection.epoch, effect: "no-op" });
  }

  const generation = { ...current, state };
  const epoch = selection.epoch + 1;

  return {
    selection: { ...selection, epoch },
    generation,
    commands: [changed("prepared", actor, epoch, current.label, outcome.status)],
    reply: { generation: wireGeneration(generation), epoch, effect: "recorded" },
  };
}

export function submission(
  selection: Selection,
  existing: LabeledGeneration | undefined,
  candidate: Readonly<{ label: GenerationLabel; harnessCommit: HarnessCommit }>,
  actor: GenerationActor,
): Step<Submission> {
  if (existing !== undefined) {
    return reply({
      kind: "candidate-submitted",
      generation: wireGeneration(existing),
      epoch: selection.epoch,
    });
  }

  const generation = { ...candidate, state: GenerationState.cases.Candidate.make({}) };
  const epoch = selection.epoch + 1;

  return {
    selection: { ...selection, epoch },
    generation,
    commands: [changed("submitted", actor, epoch, candidate.label)],
    reply: { kind: "candidate-submitted", generation: wireGeneration(generation), epoch },
  };
}
