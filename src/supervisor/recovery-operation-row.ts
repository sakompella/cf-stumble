import type { EpisodeRow } from "./recovery-model.js";
import type { RecoveryEpisodeId, RecoveryOperation } from "./recovery-types.js";

export function operationFromRow(
  row: EpisodeRow,
  id: RecoveryEpisodeId,
): RecoveryOperation | undefined {
  if (isAbsent(row)) {
    return undefined;
  }
  if (!isComplete(row)) {
    throw invalidOperation(id, "fields");
  }
  if (!isWithinBounds(row)) {
    throw invalidOperation(id, "bounds");
  }
  if (row.operation_kind === "repair" && row.preparation_check_id_at_open === null) {
    return repairOperation(row, id);
  }
  if (
    row.operation_kind === "startup-check" &&
    row.preparation_check_id_at_open !== null &&
    Number.isSafeInteger(row.preparation_check_id_at_open) &&
    row.preparation_check_id_at_open >= 0
  ) {
    return startupCheckOperation(row, id);
  }
  throw invalidOperation(id, "kind");
}

function isAbsent(row: EpisodeRow): boolean {
  return (
    row.operation_kind === null &&
    row.operation_key === null &&
    row.operation_attempt === null &&
    row.operation_deadline_at === null &&
    row.operation_state === null &&
    row.preparation_check_id_at_open === null
  );
}

function isComplete(row: EpisodeRow): row is CompleteOperationRow {
  return (
    row.operation_kind !== null &&
    row.operation_key !== null &&
    row.operation_attempt !== null &&
    row.operation_deadline_at !== null &&
    row.operation_state !== null
  );
}

function isWithinBounds(row: CompleteOperationRow): boolean {
  return (
    Number.isSafeInteger(row.operation_attempt) &&
    row.operation_attempt >= 1 &&
    row.operation_attempt <= row.attempts_used &&
    Number.isSafeInteger(row.operation_deadline_at) &&
    row.operation_deadline_at >= row.started_at &&
    row.operation_deadline_at <= row.recovery_deadline_at
  );
}

function repairOperation(row: CompleteOperationRow, id: RecoveryEpisodeId): RecoveryOperation {
  const key = expectedKey(id, "repair", row.operation_attempt, row.operation_key);
  if (row.operation_state === "open") {
    return {
      kind: "repair",
      attempt: row.operation_attempt,
      key,
      deadlineAt: row.operation_deadline_at,
      state: "open",
    };
  }
  if (row.operation_state === "needs-reconciliation") {
    return {
      kind: "repair",
      attempt: row.operation_attempt,
      key,
      deadlineAt: row.operation_deadline_at,
      state: "needs-reconciliation",
    };
  }
  throw invalidOperation(id, "state");
}

function startupCheckOperation(
  row: CompleteOperationRow,
  id: RecoveryEpisodeId,
): RecoveryOperation {
  const key = expectedKey(id, "startup-check", row.operation_attempt, row.operation_key);
  const preparationCheckIdAtOpen = row.preparation_check_id_at_open;
  if (preparationCheckIdAtOpen === null) {
    throw invalidOperation(id, "startup check snapshot");
  }
  if (row.operation_state === "open") {
    return {
      kind: "startup-check",
      attempt: row.operation_attempt,
      key,
      deadlineAt: row.operation_deadline_at,
      preparationCheckIdAtOpen,
      state: "open",
    };
  }
  if (row.operation_state === "needs-reconciliation") {
    return {
      kind: "startup-check",
      attempt: row.operation_attempt,
      key,
      deadlineAt: row.operation_deadline_at,
      preparationCheckIdAtOpen,
      state: "needs-reconciliation",
    };
  }
  throw invalidOperation(id, "state");
}

function expectedKey(
  id: RecoveryEpisodeId,
  kind: "repair" | "startup-check",
  attempt: number,
  key: string,
): string {
  const expected = `recovery-${id}:${kind}:${attempt}`;
  if (key !== expected) {
    throw invalidOperation(id, "key");
  }
  return expected;
}

type CompleteOperationRow = EpisodeRow & {
  readonly operation_kind: string;
  readonly operation_key: string;
  readonly operation_attempt: number;
  readonly operation_deadline_at: number;
  readonly operation_state: string;
};

function invalidOperation(id: RecoveryEpisodeId, field: string): Error {
  return new Error(`invalid persisted recovery ${id}: operation ${field}`);
}
