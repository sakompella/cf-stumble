import type { HarnessCommit } from "../harness-commit.js";
import type { GenerationLabel, GenerationRecord, GenerationStatus } from "./generations.js";

export type GenerationRow = {
  readonly label: GenerationLabel;
  readonly harness_commit: HarnessCommit;
  readonly status: GenerationStatus;
  readonly was_active: number;
  readonly facet_compatibility: string | null;
};

export type SelectionRow = {
  readonly active_label: GenerationLabel | null;
  readonly epoch: number;
};

export const GENERATION_COLUMNS = "label, harness_commit, status, was_active, facet_compatibility";

export function recordFromRow(row: GenerationRow): GenerationRecord {
  return {
    generation: { label: row.label, harnessCommit: row.harness_commit, status: row.status },
    wasActive: row.was_active === 1,
    compatibility: row.facet_compatibility ?? undefined,
  };
}

export function allRecords(sql: SqlStorage): readonly GenerationRecord[] {
  return sql
    .exec<GenerationRow>(`SELECT ${GENERATION_COLUMNS} FROM generations ORDER BY label ASC`)
    .toArray()
    .map(recordFromRow);
}
