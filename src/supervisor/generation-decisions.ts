import type {
  ActivationCommand,
  ControlProblemCode,
  GenerationControlResult,
  GenerationRecord,
  PreparationOutcome,
  PreparationRecord,
  Selection,
} from "./generations.js";

function refused(code: ControlProblemCode): GenerationControlResult {
  return { ok: false, problem: { code } };
}

export function decideActivation(
  command: ActivationCommand,
  target: GenerationRecord | undefined,
  selection: Selection,
  compatibility: string,
): GenerationControlResult {
  if (command.observedEpoch !== selection.epoch) return refused("stale-epoch");

  if (target === undefined) return refused("unknown-generation");

  if (target.generation.status !== "ready") return refused("not-ready");

  if (command.kind === "rollback" && !target.wasActive) return refused("not-previously-active");

  if (target.compatibility !== compatibility) return refused("facet-compatibility-mismatch");

  const kind = command.kind === "activate" ? "activated" : "rolled-back";
  const unchanged = selection.activeLabel === target.generation.label;

  return {
    ok: true,
    outcome: {
      kind,
      generation: target.generation,
      epoch: unchanged ? selection.epoch : selection.epoch + 1,
      effect: unchanged ? "no-op" : "activated",
    },
  };
}

export function decidePreparation(
  current: GenerationRecord,
  outcome: PreparationOutcome,
  selection: Selection,
): PreparationRecord {
  const compatibility = outcome.status === "ready" ? outcome.compatibility : undefined;

  const unchanged =
    current.generation.status === outcome.status && current.compatibility === compatibility;

  return {
    record: {
      ...current,
      generation: { ...current.generation, status: outcome.status },
      compatibility,
    },
    epoch: unchanged ? selection.epoch : selection.epoch + 1,
    effect: unchanged ? "no-op" : "recorded",
  };
}
