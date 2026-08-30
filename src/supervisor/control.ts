import { parseHarnessCommit } from "../harness-commit.js";
import { parseGenerationLabel } from "./generation-types.js";
import { resultFromJournalRow } from "./control-journal.js";
import type { JournalRow } from "./control-journal.js";
import type { Generation } from "./generations.js";
import type { Generations } from "./generations.js";
import type {
  CommandEffect,
  ControlProblemCode,
  GenerationCommand,
  GenerationControlResult,
  GenerationRequest,
} from "./control-types.js";

export type {
  GenerationCommand,
  GenerationControlResult,
  GenerationRequest,
  Principal,
} from "./control-types.js";

type JournalOutcomeKind = "candidate-submitted" | "activated" | "rolled-back" | "rejected";

type JournalValues = {
  readonly outcomeKind: JournalOutcomeKind;
  readonly generation: Generation | undefined;
  readonly epoch: number | undefined;
  readonly effect: CommandEffect | undefined;
  readonly problemCode: ControlProblemCode | undefined;
};

export class GenerationControl {
  private readonly generations: Generations;
  private readonly sql: SqlStorage;

  constructor(storage: DurableObjectStorage, generations: Generations) {
    this.generations = generations;
    this.sql = storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS generation_control_journal (
        request_id TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL,
        outcome_kind TEXT NOT NULL CHECK (
          outcome_kind IN ('candidate-submitted', 'activated', 'rolled-back', 'rejected')
        ),
        generation_label INTEGER,
        generation_harness_commit TEXT,
        generation_status TEXT CHECK (generation_status IN ('candidate', 'ready', 'failed')),
        epoch INTEGER,
        effect TEXT CHECK (effect IN ('activated', 'no-op')),
        problem_code TEXT
      );
    `);
  }

  execute(request: GenerationRequest): GenerationControlResult {
    return this.generations.transaction(() => {
      const fingerprint = commandFingerprint(request.command);
      const recorded = this.journalEntry(request.requestId);
      if (recorded !== undefined) {
        return recorded.fingerprint === fingerprint
          ? resultFromJournalRow(recorded)
          : { ok: false, problem: { code: "reused-request-id" } };
      }

      const result = this.decide(request);
      this.record(request.requestId, fingerprint, result);
      return result;
    });
  }

  private decide(request: GenerationRequest): GenerationControlResult {
    const active = this.generations.active();
    if (
      request.principal.kind === "harness" &&
      parseGenerationLabel(request.principal.generationLabel) !== active.generation?.label
    ) {
      return rejected("revoked-capability");
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

  private submit(harnessCommit: string): GenerationControlResult {
    const parsedHarnessCommit = parseHarnessCommit(harnessCommit);
    if (parsedHarnessCommit === undefined) {
      return rejected("invalid-harness-commit");
    }

    const result = this.generations.labelInTransaction(parsedHarnessCommit);
    return result.ok
      ? {
          ok: true,
          outcome: {
            kind: "candidate-submitted",
            generation: result.generation,
            epoch: result.epoch,
          },
        }
      : rejected(result.problem.code);
  }

  private activate(label: number, observedEpoch: number): GenerationControlResult {
    if (observedEpoch !== this.generations.active().epoch) {
      return rejected("stale-epoch");
    }

    const generationLabel = parseGenerationLabel(label);
    if (generationLabel === undefined) {
      return rejected("invalid-generation-label");
    }

    const result = this.generations.activateInTransaction(generationLabel);
    return result.ok
      ? {
          ok: true,
          outcome: {
            kind: "activated",
            generation: result.generation,
            epoch: result.epoch,
            effect: result.effect,
          },
        }
      : rejected(result.problem.code);
  }

  private rollback(label: number, observedEpoch: number): GenerationControlResult {
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

    const result = this.generations.activateInTransaction(generationLabel);
    return result.ok
      ? {
          ok: true,
          outcome: {
            kind: "rolled-back",
            generation: result.generation,
            epoch: result.epoch,
            effect: result.effect,
          },
        }
      : rejected(result.problem.code);
  }

  private journalEntry(requestId: string): JournalRow | undefined {
    return this.sql
      .exec<JournalRow>(
        `SELECT fingerprint, outcome_kind, generation_label, generation_harness_commit,
                generation_status, epoch, effect, problem_code
         FROM generation_control_journal
         WHERE request_id = ?`,
        requestId,
      )
      .toArray()[0];
  }

  private record(requestId: string, fingerprint: string, result: GenerationControlResult): void {
    const entry = journalValues(result);
    this.sql.exec(
      `INSERT INTO generation_control_journal (
         request_id, fingerprint, outcome_kind, generation_label, generation_harness_commit,
         generation_status, epoch, effect, problem_code
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      requestId,
      fingerprint,
      entry.outcomeKind,
      entry.generation?.label ?? null,
      entry.generation?.harnessCommit ?? null,
      entry.generation?.status ?? null,
      entry.epoch ?? null,
      entry.effect ?? null,
      entry.problemCode ?? null,
    );
  }
}

function rejected(code: ControlProblemCode): GenerationControlResult {
  return { ok: false, problem: { code } };
}

function commandFingerprint(command: GenerationCommand): string {
  switch (command.kind) {
    case "submit-candidate":
      return `submit-candidate|${encodeText(command.harnessCommit)}`;
    case "activate":
      return `activate|${encodeNumber(command.label)}|${encodeNumber(command.observedEpoch)}`;
    case "rollback":
      return `rollback|${encodeNumber(command.label)}|${encodeNumber(command.observedEpoch)}`;
    default:
      return impossible(command);
  }
}

function encodeText(value: string): string {
  return `${value.length}:${value}`;
}

function encodeNumber(value: number): string {
  return `${Number.isSafeInteger(value) ? "integer" : "number"}:${String(value)}`;
}

function journalValues(result: GenerationControlResult): JournalValues {
  if (!result.ok) {
    return {
      outcomeKind: "rejected",
      generation: undefined,
      epoch: undefined,
      effect: undefined,
      problemCode: result.problem.code,
    };
  }

  return {
    outcomeKind: result.outcome.kind,
    generation: result.outcome.generation,
    epoch: result.outcome.epoch,
    effect: "effect" in result.outcome ? result.outcome.effect : undefined,
    problemCode: undefined,
  };
}

function impossible(value: never): never {
  throw new Error(`unexpected value: ${String(value)}`);
}
