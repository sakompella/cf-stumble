import { Result } from "better-result";
import { parseHarnessCommit } from "../../harness-commit.js";
import { parseGenerationLabel } from "../generations/index.js";
import type { Generations } from "../generations/index.js";
import type { ControlProblemCode, GenerationControlResult, GenerationRequest } from "./request.js";

export type {
  GenerationCommand,
  GenerationControlResult,
  GenerationRequest,
  Principal,
} from "./request.js";

type ControlOutcome = Extract<GenerationControlResult, { readonly ok: true }>["outcome"];

// Control runs on Result internally and converts to the plain GenerationControlResult union once,
// in execute(), because that value crosses the Supervisor RPC boundary and is written to SQLite.
type ControlDecision = Result<ControlOutcome, ControlProblemCode>;

/**
 * Applies a generation request directly to the generation tables in one Durable Object
 * transaction (ADR-0030). There is no request journal: a candidate resubmission is safe because
 * labeling an already-labeled harness commit returns the existing generation (Generations
 * .labelInTransaction), and activating the generation that is already active is a no-op
 * (Generations.activateInTransaction). Activation and rollback still carry the epoch the requester
 * observed, and a request built on stale generation-control state is rejected (ADR-0033).
 */
export class GenerationControl {
  private readonly generations: Generations;

  constructor(generations: Generations) {
    this.generations = generations;
  }

  execute(request: GenerationRequest): GenerationControlResult {
    return this.generations.transaction(() => decisionToResult(this.decide(request)));
  }

  private decide(request: GenerationRequest): ControlDecision {
    const active = this.generations.active();
    if (request.principal.kind === "harness") {
      const generationLabel = parseGenerationLabel(request.principal.generationLabel);
      if (generationLabel === undefined || generationLabel !== active.generation?.label) {
        return rejected("revoked-capability");
      }
    }

    switch (request.command.kind) {
      case "submit-candidate":
        return this.submit(request.command.harnessCommit);
      case "activate":
        return this.activate(request.command.label, request.command.observedEpoch);
      case "rollback":
        return this.rollback(request.command.label, request.command.observedEpoch);
      default:
        return impossible(request.command);
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
    return Result.ok(outcome);
  }

  private activate(label: number, observedEpoch: number): ControlDecision {
    if (observedEpoch !== this.generations.active().epoch) {
      return rejected("stale-epoch");
    }

    const generationLabel = parseGenerationLabel(label);
    if (generationLabel === undefined) {
      return rejected("invalid-generation-label");
    }

    return this.generations
      .activateInTransaction(generationLabel)
      .map((activation): ControlOutcome => ({
        kind: "activated",
        generation: activation.generation,
        epoch: activation.epoch,
        effect: activation.effect,
      }))
      .mapError((problem) => problem.code);
  }

  private rollback(label: number, observedEpoch: number): ControlDecision {
    if (observedEpoch !== this.generations.active().epoch) {
      return rejected("stale-epoch");
    }

    const generationLabel = parseGenerationLabel(label);
    if (generationLabel === undefined) {
      return rejected("invalid-generation-label");
    }

    const target = this.generations.byLabel(generationLabel);
    if (target === undefined) {
      return rejected("unknown-generation");
    }

    if (target.status !== "ready") {
      return rejected("not-ready");
    }

    if (!this.generations.hasBeenActive(generationLabel)) {
      return rejected("not-previously-active");
    }

    return this.generations
      .activateInTransaction(generationLabel)
      .map((activation): ControlOutcome => ({
        kind: "rolled-back",
        generation: activation.generation,
        epoch: activation.epoch,
        effect: activation.effect,
      }))
      .mapError((problem) => problem.code);
  }
}

function rejected(code: ControlProblemCode): ControlDecision {
  return Result.err(code);
}

function decisionToResult(decision: ControlDecision): GenerationControlResult {
  return decision.match<GenerationControlResult>({
    ok: (outcome) => ({ ok: true, outcome }),
    err: (code) => ({ ok: false, problem: { code } }),
  });
}

function impossible(value: never): never {
  throw new Error(`unexpected value: ${String(value)}`);
}
