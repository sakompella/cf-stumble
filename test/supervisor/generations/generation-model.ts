import type { HarnessCommit } from "../../../src/harness-commit.js";
import type { RunOutcome } from "../../../src/supervisor/conversations/index.js";
import type {
  GenerationCommand,
  PreparationReply,
  RollbackReply,
} from "../../../src/supervisor/generation-machine.js";
import type {
  ControlProblemCode,
  Generation,
  GenerationControlResult,
  PreparationOutcome,
  Submission,
} from "../../../src/supervisor/generations.js";
import type { GenerationChange } from "../../../src/supervisor/history/commits.js";
import { label as generationLabel } from "./fixtures.js";

export type Kind = "candidate" | "failed" | "ready" | "served";

export type ModelGeneration = { commit: HarnessCommit; kind: Kind; compat: string | null };

export type Model = {
  epoch: number;
  active: number | null;
  proven: number | null;
  generations: Map<number, ModelGeneration>;
};

export type Command = Readonly<{
  kind: "activate" | "rollback";
  label: number;
  observedEpoch: number;
}>;

export type Result<Reply> = { reply: Reply; commands: GenerationCommand[] };

export function fresh(): Model {
  return { epoch: 0, active: null, proven: null, generations: new Map() };
}

function wire(model: Model, label: number): Generation {
  const generation = model.generations.get(label);

  if (generation === undefined) throw new Error(`no generation ${label}`);

  return {
    label: generationLabel(label),
    harnessCommit: generation.commit,
    status: generation.kind === "served" ? "ready" : generation.kind,
  };
}

function changed(
  kind: GenerationChange["kind"],
  epoch: number,
  label: number,
  outcome: string | null = null,
): GenerationCommand {
  return { _tag: "Changed", kind, epoch, label: generationLabel(label), outcome, errorCode: null };
}

export function submit(model: Model, label: number, commit: HarnessCommit): Result<Submission> {
  const known = model.generations.has(label);

  if (!known) {
    model.generations.set(label, { commit, kind: "candidate", compat: null });
    model.epoch += 1;
  }

  const reply = {
    kind: "candidate-submitted",
    generation: wire(model, label),
    epoch: model.epoch,
  } as const;

  return { reply, commands: known ? [] : [changed("submitted", model.epoch, label)] };
}

export function prepare(
  model: Model,
  label: number,
  outcome: PreparationOutcome,
): Result<PreparationReply> {
  const generation = model.generations.get(label);

  if (generation === undefined) throw new Error(`no generation ${label}`);

  const served = generation.kind === "served";
  const ready = outcome.status === "ready";
  const kind: Kind = served ? "served" : ready ? "ready" : "failed";
  const compat = ready ? outcome.compatibility : served ? generation.compat : null;

  if (kind === generation.kind && compat === generation.compat) {
    return {
      reply: { generation: wire(model, label), epoch: model.epoch, effect: "no-op" },
      commands: [],
    };
  }

  generation.kind = kind;
  generation.compat = compat;
  model.epoch += 1;

  return {
    reply: { generation: wire(model, label), epoch: model.epoch, effect: "recorded" },
    commands: [changed("prepared", model.epoch, label, outcome.status)],
  };
}

function refusal(code: ControlProblemCode): Result<GenerationControlResult> {
  return { reply: { ok: false, problem: { code } }, commands: [] };
}

function refusalOf(model: Model, command: Command, compat: string): ControlProblemCode | undefined {
  if (command.observedEpoch !== model.epoch) return "stale-epoch";

  const target = model.generations.get(command.label);

  if (target === undefined) return "unknown-generation";

  if (target.kind === "candidate" || target.kind === "failed") return "not-ready";

  if (target.kind === "ready" && command.kind === "rollback") return "not-previously-active";

  return target.compat === compat ? undefined : "facet-compatibility-mismatch";
}

export function activate(
  model: Model,
  command: Command,
  compat: string,
): Result<GenerationControlResult> {
  const code = refusalOf(model, command, compat);

  if (code !== undefined) return refusal(code);

  const kind = command.kind === "activate" ? "activated" : "rolled-back";
  const target = model.generations.get(command.label);

  if (target === undefined) throw new Error("checked above");

  const noOp = model.active === command.label;

  if (!noOp) {
    target.kind = "served";
    target.compat = compat;
    model.epoch += 1;
    model.active = command.label;
  }

  const outcome = {
    kind,
    generation: wire(model, command.label),
    epoch: model.epoch,
    effect: noOp ? "no-op" : "activated",
  } as const;

  const commands = noOp ? [] : [changed(kind, model.epoch, command.label)];

  return { reply: { ok: true, outcome }, commands };
}

export function settle(
  model: Model,
  outcome: RunOutcome,
  errorCode: string | null,
  compat: string,
): Result<RollbackReply> {
  const none = { reply: undefined, commands: [] };

  if (outcome === "completed") {
    if (model.active !== null) model.proven = model.active;

    return none;
  }

  const { active, proven, epoch } = model;

  if (active === null || proven === null || proven === active) return none;

  if (outcome !== "failed" && outcome !== "interrupted") return none;

  const fallback = generationLabel(proven);
  const label = generationLabel(active);
  const command = { kind: "rollback", label: fallback, observedEpoch: epoch } as const;
  const rollback = activate(model, command, compat);

  const failed: GenerationCommand = {
    _tag: "Changed",
    kind: "probation-failed",
    epoch,
    label,
    outcome,
    errorCode,
  };

  const done = (refused: ControlProblemCode | null): GenerationCommand => ({
    _tag: "ProbationFailed",
    label,
    fallback,
    outcome,
    errorCode,
    refused,
  });

  if (!rollback.reply.ok) {
    model.proven = null;

    return { reply: undefined, commands: [failed, done(rollback.reply.problem.code)] };
  }

  return {
    reply: { command, epoch: rollback.reply.outcome.epoch },
    commands: [failed, ...rollback.commands, done(null)],
  };
}
