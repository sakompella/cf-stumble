import { logEvent } from "../diagnostics.js";
import type { HarnessCommit } from "../harness-commit.js";
import type { Settlement } from "./conversations/index.js";
import {
  activation,
  GenerationCommand,
  preparation,
  settlement,
  submission,
  type PreparationReply,
  type RollbackReply,
  type Step,
} from "./generation-machine.js";
import {
  Serving,
  wireGeneration,
  wireRecord,
  type LabeledGeneration,
  type Selection,
} from "./generation-state.js";
import {
  generationFromRow,
  GENERATION_COLUMNS,
  rowFromGeneration,
  rowFromSelection,
  SELECTION_COLUMNS,
  selectionFromRow,
  type GenerationRow,
  type SelectionRow,
} from "./generation-rows.js";
import type { GenerationChange } from "./history/commits.js";

export type GenerationStatus = "candidate" | "ready" | "failed";

export type GenerationActor = "owner" | "conversation" | "probation";

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
  | "stale-epoch"
  | "run-active";

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

export class Generations {
  readonly #storage: DurableObjectStorage;
  readonly #sql: SqlStorage;
  readonly #compatibility: string;
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
    storage.transactionSync(() => {
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
          proven_label INTEGER REFERENCES generations(label)
            CHECK (proven_label IS NULL OR active_label IS NOT NULL),
          epoch INTEGER NOT NULL CHECK (epoch >= 0)
        );
        INSERT INTO generation_state (singleton, active_label, proven_label, epoch)
        VALUES (1, NULL, NULL, 0)
        ON CONFLICT (singleton) DO NOTHING;
      `);
    });
  }

  submit(harnessCommit: HarnessCommit, actor: GenerationActor): Submission {
    return this.#run(() => {
      const next = this.#sql
        .exec<{ label: GenerationLabel }>(
          "SELECT COALESCE(MAX(label), -1) + 1 AS label FROM generations",
        )
        .one();

      return submission(
        this.#selection(),
        this.#where("harness_commit", harnessCommit),
        { label: next.label, harnessCommit },
        actor,
      );
    });
  }

  activate(command: ActivationCommand, actor: GenerationActor): GenerationControlResult {
    return this.#run(() =>
      activation(
        this.#selection(),
        this.#generation(command.label),
        command,
        this.#compatibility,
        actor,
      ),
    );
  }

  settled(run: Settlement): RollbackReply {
    return this.#run(() => {
      const selection = this.#selection();

      const { serving } = selection;

      const fallback = Serving.guards.Probation(serving)
        ? this.#generation(serving.fallback)
        : undefined;

      const { outcome, errorCode } = run;

      return settlement(selection, fallback, { outcome, errorCode }, this.#compatibility);
    });
  }

  recordPreparation(
    label: GenerationLabel,
    outcome: PreparationOutcome,
    actor: GenerationActor,
  ): PreparationReply | undefined {
    return this.#run(() => {
      const current = this.#generation(label);

      return current === undefined
        ? { commands: [], reply: undefined }
        : preparation(this.#selection(), current, outcome, actor);
    });
  }

  active(): ActiveGeneration {
    const { serving, epoch } = this.#selection();
    const current = serving.active === null ? undefined : this.#generation(serving.active);

    return { generation: current === undefined ? undefined : wireGeneration(current), epoch };
  }

  activeCompatibility(): string | undefined {
    const { active } = this.#selection().serving;
    const current = active === null ? undefined : this.#generation(active);

    return current === undefined ? undefined : wireRecord(current).compatibility;
  }

  byLabel(label: GenerationLabel): Generation | undefined {
    const found = this.#generation(label);

    return found === undefined ? undefined : wireGeneration(found);
  }

  #run<Reply>(decide: () => Step<Reply>): Reply {
    const step = this.#storage.transactionSync(() => {
      const decided = decide();

      if (decided.generation !== undefined) this.#writeGeneration(decided.generation);

      if (decided.selection !== undefined) this.#writeSelection(decided.selection);

      return decided;
    });

    for (const command of step.commands) this.#perform(command);

    return step.reply;
  }

  #perform(command: GenerationCommand): void {
    GenerationCommand.$match(command, {
      Changed: ({ kind, actor, epoch, label, outcome, errorCode }) => {
        const changed = this.#generation(label);

        if (changed !== undefined) {
          this.#onChange?.({ kind, actor, epoch, outcome, errorCode, record: wireRecord(changed) });
        }
      },
      ProbationFailed: ({ _tag, ...fields }) => {
        logEvent("warn", "generation.probation-failed", fields);
      },
    });
  }

  #writeGeneration(generation: LabeledGeneration): void {
    const row = rowFromGeneration(generation);

    this.#sql.exec(
      `INSERT INTO generations (${GENERATION_COLUMNS}) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (label) DO UPDATE SET status = excluded.status,
         was_active = excluded.was_active, facet_compatibility = excluded.facet_compatibility`,
      row.label,
      row.harness_commit,
      row.status,
      row.was_active,
      row.facet_compatibility,
    );
  }

  #writeSelection(selection: Selection): void {
    const row = rowFromSelection(selection);

    this.#sql.exec(
      "UPDATE generation_state SET active_label = ?, proven_label = ?, epoch = ? WHERE singleton = 1",
      row.active_label,
      row.proven_label,
      row.epoch,
    );
  }

  #generation(label: GenerationLabel): LabeledGeneration | undefined {
    return this.#where("label", label);
  }

  #where(
    column: "label" | "harness_commit",
    value: GenerationLabel | HarnessCommit,
  ): LabeledGeneration | undefined {
    const row = this.#sql
      .exec<GenerationRow>(
        `SELECT ${GENERATION_COLUMNS} FROM generations WHERE ${column} = ?`,
        value,
      )
      .toArray()[0];

    return row === undefined ? undefined : generationFromRow(row);
  }

  #selection(): Selection {
    return selectionFromRow(
      this.#sql
        .exec<SelectionRow>(`SELECT ${SELECTION_COLUMNS} FROM generation_state WHERE singleton = 1`)
        .one(),
    );
  }
}
