import type { HarnessCommit } from "../harness-commit.js";
import {
  GenerationState,
  Serving,
  wireRecord,
  type LabeledGeneration,
  type Selection,
} from "./generation-state.js";
import type { GenerationLabel, GenerationStatus } from "./generations.js";

export type GenerationRow = {
  readonly label: GenerationLabel;
  readonly harness_commit: HarnessCommit;
  readonly status: GenerationStatus;
  readonly was_active: number;
  readonly facet_compatibility: string | null;
};

export type SelectionRow = {
  readonly active_label: GenerationLabel | null;
  readonly proven_label: GenerationLabel | null;
  readonly epoch: number;
};

export const GENERATION_COLUMNS = "label, harness_commit, status, was_active, facet_compatibility";

export const SELECTION_COLUMNS = "active_label, proven_label, epoch";

function stateFromRow(row: GenerationRow): GenerationState {
  const compatibility = row.facet_compatibility;

  if (row.status === "failed") return GenerationState.cases.Failed.make({});

  if (row.status === "candidate" || compatibility === null) {
    return GenerationState.cases.Candidate.make({});
  }

  return row.was_active === 1
    ? GenerationState.cases.Served.make({ compatibility })
    : GenerationState.cases.Ready.make({ compatibility });
}

export function generationFromRow(row: GenerationRow): LabeledGeneration {
  return { label: row.label, harnessCommit: row.harness_commit, state: stateFromRow(row) };
}

export function rowFromGeneration(entry: LabeledGeneration): GenerationRow {
  const { generation, wasActive, compatibility } = wireRecord(entry);

  return {
    label: generation.label,
    harness_commit: generation.harnessCommit,
    status: generation.status,
    was_active: wasActive ? 1 : 0,
    facet_compatibility: compatibility ?? null,
  };
}

export function selectionFromRow(row: SelectionRow): Selection {
  const { active_label: active, proven_label: proven, epoch } = row;

  if (active === null || proven === null) {
    return { epoch, serving: Serving.cases.Unproven.make({ active }) };
  }

  return {
    epoch,
    serving:
      active === proven
        ? Serving.cases.Proven.make({ active })
        : Serving.cases.Probation.make({ active, fallback: proven }),
  };
}

export function rowFromSelection({ epoch, serving }: Selection): SelectionRow {
  return Serving.match(serving, {
    Unproven: ({ active }) => ({ active_label: active, proven_label: null, epoch }),
    Proven: ({ active }) => ({ active_label: active, proven_label: active, epoch }),
    Probation: ({ active, fallback }) => ({ active_label: active, proven_label: fallback, epoch }),
  });
}
