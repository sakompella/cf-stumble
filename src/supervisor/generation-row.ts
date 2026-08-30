import { parseHarnessCommit } from "../harness-commit.js";
import {
  parseGenerationLabel,
  type GenerationLabel,
  type GenerationStatus,
} from "./generation-types.js";
import type { Generation } from "./generation-types.js";

export type GenerationRow = {
  readonly label: number;
  readonly harness_commit: string;
  readonly status: string;
};

export function generationFromRow(row: GenerationRow): Generation {
  const label = generationLabelFromPersistence(row.label, `generation ${row.label} label`);
  const harnessCommit = parseHarnessCommit(row.harness_commit);
  const status = generationStatusFromPersistence(row.status);
  if (harnessCommit === undefined || status === undefined) {
    throw new Error(`invalid persisted generation ${row.label}`);
  }

  return { label, harnessCommit, status };
}

export function generationLabelFromPersistence(
  value: number,
  description: string,
): GenerationLabel {
  const label = parseGenerationLabel(value);
  if (label === undefined) {
    throw new Error(`invalid persisted ${description}`);
  }

  return label;
}

function generationStatusFromPersistence(value: string): GenerationStatus | undefined {
  return value === "candidate" || value === "ready" || value === "failed" ? value : undefined;
}
