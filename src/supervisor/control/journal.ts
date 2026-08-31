import { parseHarnessCommit } from "../../harness-commit.js";
import { parseGenerationLabel } from "../generations/index.js";
import type { CommandEffect, ControlProblemCode, GenerationControlResult } from "./request.js";
import type { GenerationStatus } from "../generations/index.js";

export type JournalRow = {
  readonly fingerprint: string;
  readonly outcome_kind: string;
  readonly generation_label: number | null;
  readonly generation_harness_commit: string | null;
  readonly generation_status: string | null;
  readonly epoch: number | null;
  readonly effect: string | null;
  readonly problem_code: string | null;
};

type JournalOutcomeKind = "candidate-submitted" | "activated" | "rolled-back" | "rejected";

export function resultFromJournalRow(row: JournalRow): GenerationControlResult {
  const outcomeKind = journalOutcomeKindFromRow(row.outcome_kind);
  if (outcomeKind === "rejected" && row.problem_code !== null) {
    const problemCode = controlProblemCodeFromJournal(row.problem_code);
    if (problemCode !== undefined) {
      return rejected(problemCode);
    }
  }

  if (
    row.generation_label !== null &&
    row.generation_harness_commit !== null &&
    row.generation_status !== null &&
    row.epoch !== null
  ) {
    const label = parseGenerationLabel(row.generation_label);
    const harnessCommit = parseHarnessCommit(row.generation_harness_commit);
    const status = generationStatusFromJournal(row.generation_status);
    if (label === undefined || harnessCommit === undefined || status === undefined) {
      throw new Error("invalid generation control journal entry");
    }
    const generation = { label, harnessCommit, status };

    if (outcomeKind === "candidate-submitted") {
      return { ok: true, outcome: { kind: "candidate-submitted", generation, epoch: row.epoch } };
    }

    const effect = row.effect === null ? undefined : commandEffectFromJournal(row.effect);
    if (effect !== undefined && (outcomeKind === "activated" || outcomeKind === "rolled-back")) {
      return { ok: true, outcome: { kind: outcomeKind, generation, epoch: row.epoch, effect } };
    }
  }

  throw new Error("invalid generation control journal entry");
}

function rejected(code: ControlProblemCode): GenerationControlResult {
  return { ok: false, problem: { code } };
}

function journalOutcomeKindFromRow(value: string): JournalOutcomeKind {
  if (
    value === "candidate-submitted" ||
    value === "activated" ||
    value === "rolled-back" ||
    value === "rejected"
  ) {
    return value;
  }

  throw new Error("invalid generation control journal entry");
}

function generationStatusFromJournal(value: string): GenerationStatus | undefined {
  return value === "candidate" || value === "ready" || value === "failed" ? value : undefined;
}

function commandEffectFromJournal(value: string): CommandEffect | undefined {
  return value === "activated" || value === "no-op" ? value : undefined;
}

function controlProblemCodeFromJournal(value: string): ControlProblemCode | undefined {
  return value === "invalid-harness-commit" ||
    value === "invalid-generation-label" ||
    value === "unknown-generation" ||
    value === "not-ready" ||
    value === "not-previously-active" ||
    value === "revoked-capability" ||
    value === "stale-epoch" ||
    value === "reused-request-id"
    ? value
    : undefined;
}
