import type { HarnessCommit } from "../harness-commit.js";

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
  piDurableVersion: string | undefined;
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
  | "pi-durable-version-mismatch"
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
  | Readonly<{ status: "ready"; piDurableVersion: string }>
  | Readonly<{ status: "failed" }>;

export type PreparationRecord = Readonly<{
  record: GenerationRecord;
  epoch: number;
  effect: "recorded" | "no-op";
}>;

function refused(code: ControlProblemCode): GenerationControlResult {
  return { ok: false, problem: { code } };
}

export function decideActivation(
  command: ActivationCommand,
  target: GenerationRecord | undefined,
  selection: Selection,
  piDurableVersion: string,
): GenerationControlResult {
  if (command.observedEpoch !== selection.epoch) return refused("stale-epoch");

  if (target === undefined) return refused("unknown-generation");

  if (target.generation.status !== "ready") return refused("not-ready");

  if (command.kind === "rollback" && !target.wasActive) return refused("not-previously-active");

  if (target.piDurableVersion !== piDurableVersion) return refused("pi-durable-version-mismatch");

  const kind = command.kind === "activate" ? "activated" : "rolled-back";
  const unchanged = selection.activeLabel === target.generation.label;

  return {
    ok: true,
    outcome: {
      kind,
      generation: target.generation,
      epoch: unchanged ? selection.epoch : selection.epoch + 1,
      effect: unchanged ? "no-op" : "activated",
    },
  };
}

export function decidePreparation(
  current: GenerationRecord,
  outcome: PreparationOutcome,
  selection: Selection,
): PreparationRecord {
  const piDurableVersion = outcome.status === "ready" ? outcome.piDurableVersion : undefined;

  const unchanged =
    current.generation.status === outcome.status && current.piDurableVersion === piDurableVersion;

  return {
    record: {
      ...current,
      generation: { ...current.generation, status: outcome.status },
      piDurableVersion,
    },
    epoch: selection.epoch + 1,
    effect: unchanged ? "no-op" : "recorded",
  };
}

type GenerationRow = {
  readonly label: GenerationLabel;
  readonly harness_commit: HarnessCommit;
  readonly status: GenerationStatus;
  readonly was_active: number;
  readonly pi_durable_version: string | null;
};

type SelectionRow = {
  readonly active_label: GenerationLabel | null;
  readonly epoch: number;
};

const GENERATION_COLUMNS = "label, harness_commit, status, was_active, pi_durable_version";

function recordFromRow(row: GenerationRow): GenerationRecord {
  return {
    generation: { label: row.label, harnessCommit: row.harness_commit, status: row.status },
    wasActive: row.was_active === 1,
    piDurableVersion: row.pi_durable_version ?? undefined,
  };
}

export class Generations {
  readonly #storage: DurableObjectStorage;
  readonly #sql: SqlStorage;
  readonly #piDurableVersion: string;

  constructor(storage: DurableObjectStorage, piDurableVersion: string) {
    this.#storage = storage;
    this.#sql = storage.sql;
    this.#piDurableVersion = piDurableVersion;
    this.#migrateActivationHistory();
    this.#migratePiDurableVersion();
    this.#sql.exec(`
      CREATE TABLE IF NOT EXISTS generations (
        label INTEGER PRIMARY KEY CHECK (label >= 0),
        harness_commit TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK (status IN ('candidate', 'ready', 'failed')),
        was_active INTEGER NOT NULL DEFAULT 0 CHECK (was_active IN (0, 1)),
        pi_durable_version TEXT
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
    return this.#storage.transactionSync(() => {
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
  }

  activate(command: ActivationCommand): GenerationControlResult {
    return this.#storage.transactionSync(() => {
      const result = decideActivation(
        command,
        this.#record(command.label),
        this.#selection(),
        this.#piDurableVersion,
      );

      if (result.ok && result.outcome.effect === "activated") {
        this.#select(command.label, result.outcome.epoch);
      }

      return result;
    });
  }

  recordPreparation(
    label: GenerationLabel,
    outcome: PreparationOutcome,
  ): PreparationRecord | undefined {
    return this.#storage.transactionSync(() => {
      const current = this.#record(label);

      return current === undefined
        ? undefined
        : this.#writePreparation(decidePreparation(current, outcome, this.#selection()));
    });
  }

  #writePreparation(recorded: PreparationRecord): PreparationRecord {
    const { generation, piDurableVersion } = recorded.record;

    this.#sql.exec(
      "UPDATE generations SET status = ?, pi_durable_version = ? WHERE label = ?",
      generation.status,
      piDurableVersion ?? null,
      generation.label,
    );
    this.#writeEpoch(recorded.epoch);

    return recorded;
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

  #migrateActivationHistory(): void {
    const legacy = this.#sql
      .exec(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'active_generation_history'",
      )
      .toArray();

    if (legacy.length === 0) return;

    this.#sql.exec(`
      ALTER TABLE generations
        ADD COLUMN was_active INTEGER NOT NULL DEFAULT 0 CHECK (was_active IN (0, 1));
      UPDATE generations SET was_active = 1
        WHERE label IN (SELECT label FROM active_generation_history);
      DROP TABLE active_generation_history;
      ALTER TABLE generation_state DROP COLUMN activation_id;
    `);
  }

  #migratePiDurableVersion(): void {
    const columns = this.#sql
      .exec<{ name: string }>("SELECT name FROM pragma_table_info('generations')")
      .toArray()
      .map((column) => column.name);

    if (columns.length === 0 || columns.includes("pi_durable_version")) return;

    this.#sql.exec("ALTER TABLE generations ADD COLUMN pi_durable_version TEXT");
  }
}
