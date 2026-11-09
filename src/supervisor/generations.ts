import { logEvent } from "../diagnostics.js";
import type { HarnessCommit } from "../harness-commit.js";
import { decideActivation, decidePreparation } from "./generation-decisions.js";
import {
  allRecords,
  GENERATION_COLUMNS,
  recordFromRow,
  type GenerationRow,
  type SelectionRow,
} from "./generation-rows.js";
import { GenerationProbation, type RunOutcome } from "./probation.js";
import type { GenerationChange } from "./history/commits.js";

export type GenerationStatus = "candidate" | "ready" | "failed";

declare const generationLabelBrand: unique symbol;

export type GenerationLabel = number & {
  readonly [generationLabelBrand]: "GenerationLabel";
};

export function isGenerationLabel(value: number): value is GenerationLabel {
  return Number.isSafeInteger(value) && value >= 0;
}

export type Generation = Readonly<{
  label: GenerationLabel;
  harnessCommit: HarnessCommit;
  status: GenerationStatus;
}>;

export type GenerationRecord = Readonly<{
  generation: Generation;
  wasActive: boolean;
  compatibility: string | undefined;
}>;

export type ActiveGeneration = Readonly<{
  generation: Generation | undefined;
  epoch: number;
}>;

export type Selection = Readonly<{
  activeLabel: GenerationLabel | undefined;
  epoch: number;
}>;

export type ActivationCommand = Readonly<{
  kind: "activate" | "rollback";
  label: GenerationLabel;
  observedEpoch: number;
}>;

export type Submission = Readonly<{
  kind: "candidate-submitted";
  generation: Generation;
  epoch: number;
}>;

export type ControlProblemCode =
  | "unknown-generation"
  | "not-ready"
  | "not-previously-active"
  | "facet-compatibility-mismatch"
  | "stale-epoch";

export type GenerationControlResult =
  | Readonly<{
      ok: true;
      outcome: Readonly<{
        kind: "activated" | "rolled-back";
        generation: Generation;
        epoch: number;
        effect: "activated" | "no-op";
      }>;
    }>
  | Readonly<{ ok: false; problem: Readonly<{ code: ControlProblemCode }> }>;

export type PreparationOutcome =
  | Readonly<{ status: "ready"; compatibility: string }>
  | Readonly<{ status: "failed" }>;

export type PreparationRecord = Readonly<{
  record: GenerationRecord;
  epoch: number;
  effect: "recorded" | "no-op";
}>;

export class Generations {
  readonly #storage: DurableObjectStorage;
  readonly #sql: SqlStorage;
  readonly #compatibility: string;
  readonly #probation: GenerationProbation;
  readonly #onChange: ((change: GenerationChange) => void) | undefined;

  constructor(
    storage: DurableObjectStorage,
    compatibility: string,
    onChange?: (change: GenerationChange) => void,
  ) {
    this.#storage = storage;
    this.#onChange = onChange;
    this.#sql = storage.sql;
    this.#compatibility = compatibility;
    this.#probation = new GenerationProbation(storage.kv);
    this.#sql.exec(`
      CREATE TABLE IF NOT EXISTS generations (
        label INTEGER PRIMARY KEY CHECK (label >= 0),
        harness_commit TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK (status IN ('candidate', 'ready', 'failed')),
        was_active INTEGER NOT NULL DEFAULT 0 CHECK (was_active IN (0, 1)),
        facet_compatibility TEXT
      );
      CREATE TABLE IF NOT EXISTS generation_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        active_label INTEGER REFERENCES generations(label),
        epoch INTEGER NOT NULL CHECK (epoch >= 0)
      );
      INSERT INTO generation_state (singleton, active_label, epoch)
      VALUES (1, NULL, 0)
      ON CONFLICT (singleton) DO NOTHING;
    `);
  }

  submit(harnessCommit: HarnessCommit): Submission {
    const before = this.#selection().epoch;

    const submission = this.#storage.transactionSync((): Submission => {
      const { epoch } = this.#selection();

      const existing = this.#sql
        .exec<GenerationRow>(
          `SELECT ${GENERATION_COLUMNS} FROM generations WHERE harness_commit = ?`,
          harnessCommit,
        )
        .toArray()[0];

      if (existing !== undefined) {
        return {
          kind: "candidate-submitted",
          generation: recordFromRow(existing).generation,
          epoch,
        };
      }

      const inserted = this.#sql
        .exec<GenerationRow>(
          `INSERT INTO generations (label, harness_commit, status)
           VALUES ((SELECT COALESCE(MAX(label), -1) + 1 FROM generations), ?, 'candidate')
           RETURNING ${GENERATION_COLUMNS}`,
          harnessCommit,
        )
        .one();

      this.#writeEpoch(epoch + 1);

      return {
        kind: "candidate-submitted",
        generation: recordFromRow(inserted).generation,
        epoch: epoch + 1,
      };
    });

    if (submission.epoch !== before) {
      this.#announce("submitted", submission.epoch, submission.generation.label);
    }

    return submission;
  }

  activate(command: ActivationCommand): GenerationControlResult {
    const result = this.#storage.transactionSync(() => {
      const decided = decideActivation(
        command,
        this.#record(command.label),
        this.#selection(),
        this.#compatibility,
      );

      if (decided.ok && decided.outcome.effect === "activated") {
        this.#select(command.label, decided.outcome.epoch);
        this.#probation.activated(command.label);
      }

      return decided;
    });

    if (result.ok && result.outcome.effect === "activated") {
      this.#announce(
        command.kind === "activate" ? "activated" : "rolled-back",
        result.outcome.epoch,
        command.label,
      );
    }

    return result;
  }

  settled({
    outcome,
    errorCode,
  }: Readonly<{ outcome: RunOutcome; errorCode: string | null }>):
    | Readonly<{ command: ActivationCommand; epoch: number }>
    | undefined {
    const { activeLabel } = this.#selection();

    const fallback =
      activeLabel === undefined ? undefined : this.#probation.settled(activeLabel, outcome);

    if (fallback === undefined || activeLabel === undefined) return undefined;

    this.#announce("probation-failed", this.#selection().epoch, activeLabel, outcome, errorCode);

    const command = {
      kind: "rollback",
      label: fallback,
      observedEpoch: this.#selection().epoch,
    } as const;

    const result = this.activate(command);

    logEvent("warn", "generation.probation-failed", {
      label: activeLabel,
      fallback,
      outcome,
      errorCode,
      refused: result.ok ? null : result.problem.code,
    });

    return result.ok && result.outcome.effect === "activated"
      ? { command, epoch: result.outcome.epoch }
      : undefined;
  }

  recordPreparation(
    label: GenerationLabel,
    outcome: PreparationOutcome,
  ): PreparationRecord | undefined {
    const recorded = this.#storage.transactionSync(() => {
      const current = this.#record(label);

      return current === undefined
        ? undefined
        : this.#writePreparation(decidePreparation(current, outcome, this.#selection()));
    });

    if (recorded !== undefined && recorded.effect === "recorded") {
      this.#announce("prepared", recorded.epoch, label, outcome.status);
    }

    return recorded;
  }

  #announce(
    kind: GenerationChange["kind"],
    epoch: number,
    label: GenerationLabel,
    outcome: string | null = null,
    errorCode: string | null = null,
  ): void {
    const record = this.#record(label);

    if (record !== undefined) {
      this.#onChange?.({ kind, epoch, outcome, errorCode, record });
    }
  }

  #writePreparation(recorded: PreparationRecord): PreparationRecord {
    const { generation, compatibility } = recorded.record;

    this.#sql.exec(
      "UPDATE generations SET status = ?, facet_compatibility = ? WHERE label = ?",
      generation.status,
      compatibility ?? null,
      generation.label,
    );
    this.#writeEpoch(recorded.epoch);

    return recorded;
  }

  all(): readonly GenerationRecord[] {
    return allRecords(this.#sql);
  }

  active(): ActiveGeneration {
    const { activeLabel, epoch } = this.#selection();

    return {
      generation: activeLabel === undefined ? undefined : this.#record(activeLabel)?.generation,
      epoch,
    };
  }

  byLabel(label: GenerationLabel): Generation | undefined {
    return this.#record(label)?.generation;
  }

  #record(label: GenerationLabel): GenerationRecord | undefined {
    const row = this.#sql
      .exec<GenerationRow>(`SELECT ${GENERATION_COLUMNS} FROM generations WHERE label = ?`, label)
      .toArray()[0];

    return row === undefined ? undefined : recordFromRow(row);
  }

  #selection(): Selection {
    const row = this.#sql
      .exec<SelectionRow>("SELECT active_label, epoch FROM generation_state WHERE singleton = 1")
      .one();

    return { activeLabel: row.active_label ?? undefined, epoch: row.epoch };
  }

  #writeEpoch(epoch: number): void {
    this.#sql.exec("UPDATE generation_state SET epoch = ? WHERE singleton = 1", epoch);
  }

  #select(label: GenerationLabel, epoch: number): void {
    this.#sql.exec(
      "UPDATE generation_state SET active_label = ?, epoch = ? WHERE singleton = 1",
      label,
      epoch,
    );
    this.#sql.exec("UPDATE generations SET was_active = 1 WHERE label = ?", label);
  }
}
