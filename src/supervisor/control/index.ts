import * as Result from "effect/Result";
import { parseHarnessCommit } from "../../harness-commit.js";
import { parseGenerationLabel } from "../generations/index.js";
import type { GenerationLabel, Generations } from "../generations/index.js";
import type { ControlProblemCode, GenerationCommand, GenerationControlResult } from "./request.js";

export type { ControlProblemCode, GenerationCommand, GenerationControlResult } from "./request.js";

type ControlOutcome = Extract<GenerationControlResult, { readonly ok: true }>["outcome"];

type ActivationKind = Exclude<ControlOutcome["kind"], "candidate-submitted">;

type ControlDecision = Result.Result<ControlOutcome, ControlProblemCode>;

export class GenerationControl {
  private readonly generations: Generations;

  constructor(generations: Generations) {
    this.generations = generations;
  }

  execute(command: GenerationCommand): GenerationControlResult {
    return this.generations.transaction(() => decisionToResult(this.decide(command)));
  }

  private decide(command: GenerationCommand): ControlDecision {
    switch (command.kind) {
      case "submit-candidate":
        return this.submit(command.harnessCommit);
      case "activate":
        return this.activate("activated", command.label, command.observedEpoch);
      case "rollback":
        return this.activate(
          "rolled-back",
          command.label,
          command.observedEpoch,
          (generationLabel) => this.rollbackProblem(generationLabel),
        );
      default:
        return impossible(command);
    }
  }

  private submit(harnessCommit: string): ControlDecision {
    const parsedHarnessCommit = parseHarnessCommit(harnessCommit);

    if (parsedHarnessCommit === undefined) {
      return rejected("invalid-harness-commit");
    }

    const result = this.generations.labelInTransaction(parsedHarnessCommit);

    const outcome: ControlOutcome = {
      kind: "candidate-submitted",
      generation: result.generation,
      epoch: result.epoch,
    };

    return Result.succeed(outcome);
  }

  private activate(
    kind: ActivationKind,
    label: number,
    observedEpoch: number,
    guard?: (generationLabel: GenerationLabel) => ControlProblemCode | undefined,
  ): ControlDecision {
    if (observedEpoch !== this.generations.active().epoch) {
      return rejected("stale-epoch");
    }

    const generationLabel = parseGenerationLabel(label);

    if (generationLabel === undefined) {
      return rejected("invalid-generation-label");
    }

    const refusal = guard?.(generationLabel);

    if (refusal !== undefined) {
      return rejected(refusal);
    }

    return Result.mapBoth(this.generations.activateInTransaction(generationLabel), {
      onSuccess: (activation): ControlOutcome => ({
        kind,
        generation: activation.generation,
        epoch: activation.epoch,
        effect: activation.effect,
      }),
      onFailure: (problem) => problem.code,
    });
  }

  private rollbackProblem(label: GenerationLabel): ControlProblemCode | undefined {
    const target = this.generations.byLabel(label);

    if (target === undefined) {
      return "unknown-generation";
    }

    if (target.status !== "ready") {
      return "not-ready";
    }

    return this.generations.hasBeenActive(label) ? undefined : "not-previously-active";
  }
}

function rejected(code: ControlProblemCode): ControlDecision {
  return Result.fail(code);
}

function decisionToResult(decision: ControlDecision): GenerationControlResult {
  return Result.match(decision, {
    onSuccess: (outcome): GenerationControlResult => ({ ok: true, outcome }),
    onFailure: (code): GenerationControlResult => ({ ok: false, problem: { code } }),
  });
}

function impossible(value: never): never {
  throw new Error(`unexpected value: ${String(value)}`);
}
