export type RelayOutcome =
  | "pending"
  | "pre-header-failure"
  | "body-completed"
  | "body-failed"
  | "relay-cancelled"
  | "bounded-abandonment";

export type RelayFactKind = Exclude<RelayOutcome, "pending"> | "headers-received";

export type RelayAttribution = {
  readonly generationLabel: number | undefined;
  readonly activationId: number | undefined;
  readonly preparationCheckId: number | undefined;
};

type RelayAttemptBase = RelayAttribution & {
  readonly id: number;
  readonly startedAt: number;
  readonly deadlineAt: number;
};

export type RelayAttempt =
  | (RelayAttemptBase & {
      readonly outcome: "pending";
      readonly responseStatus: number | undefined;
      readonly finishedAt: undefined;
    })
  | (RelayAttemptBase & {
      readonly outcome: "pre-header-failure";
      readonly responseStatus: undefined;
      readonly finishedAt: number;
    })
  | (RelayAttemptBase & {
      readonly outcome: "body-completed" | "body-failed";
      readonly responseStatus: number;
      readonly finishedAt: number;
    })
  | (RelayAttemptBase & {
      readonly outcome: "relay-cancelled";
      readonly responseStatus: number | undefined;
      readonly finishedAt: number;
    })
  | (RelayAttemptBase & {
      readonly outcome: "bounded-abandonment";
      readonly responseStatus: number | undefined;
      readonly finishedAt: number;
    });

export type RelayFact = RelayAttribution & {
  readonly attemptId: number;
  readonly kind: RelayFactKind;
  readonly responseStatus: number | undefined;
  readonly observedAt: number;
};

export type AttemptRow = {
  readonly id: number;
  readonly generation_label: number | null;
  readonly activation_id: number | null;
  readonly preparation_check_id: number | null;
  readonly started_at: number;
  readonly deadline_at: number;
  readonly response_status: number | null;
  readonly outcome: RelayOutcome;
  readonly finished_at: number | null;
};

export type FactRow = {
  readonly attempt_id: number;
  readonly generation_label: number | null;
  readonly activation_id: number | null;
  readonly preparation_check_id: number | null;
  readonly kind: RelayFactKind;
  readonly response_status: number | null;
  readonly observed_at: number;
};

export function attemptFromRow(row: AttemptRow): RelayAttempt {
  const base: RelayAttemptBase = {
    id: row.id,
    generationLabel: row.generation_label ?? undefined,
    activationId: row.activation_id ?? undefined,
    preparationCheckId: row.preparation_check_id ?? undefined,
    startedAt: row.started_at,
    deadlineAt: row.deadline_at,
  };
  const status = row.response_status ?? undefined;
  const finishedAt = row.finished_at ?? undefined;

  switch (row.outcome) {
    case "pending":
      return { ...base, outcome: row.outcome, responseStatus: status, finishedAt: undefined };
    case "pre-header-failure":
      if (status === undefined && finishedAt !== undefined) {
        return { ...base, outcome: row.outcome, responseStatus: undefined, finishedAt };
      }
      break;
    case "body-completed":
    case "body-failed":
      if (status !== undefined && finishedAt !== undefined) {
        return { ...base, outcome: row.outcome, responseStatus: status, finishedAt };
      }
      break;
    case "relay-cancelled":
    case "bounded-abandonment":
      if (finishedAt !== undefined) {
        return { ...base, outcome: row.outcome, responseStatus: status, finishedAt };
      }
      break;
    default:
      return impossible(row.outcome);
  }

  throw new Error(`invalid persisted relay attempt ${row.id}`);
}

export function factFromRow(row: FactRow): RelayFact {
  return {
    attemptId: row.attempt_id,
    generationLabel: row.generation_label ?? undefined,
    activationId: row.activation_id ?? undefined,
    preparationCheckId: row.preparation_check_id ?? undefined,
    kind: row.kind,
    responseStatus: row.response_status ?? undefined,
    observedAt: row.observed_at,
  };
}

function impossible(value: never): never {
  throw new Error(`unexpected relay outcome: ${String(value)}`);
}
