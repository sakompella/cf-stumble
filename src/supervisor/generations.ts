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
  type Step,
} from "./generation-machine.js";
import {
  Serving,
  wireGeneration,
  wireRecord,
  type ActivationCommand,
  type ActiveGeneration,
  type Generation,
  type GenerationActor,
  type GenerationControlResult,
  type GenerationLabel,
  type LabeledGeneration,
  type PreparationOutcome,
  type Selection,
  type Submission,
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

export type GenerationPorts = Readonly<{
  changed: (change: GenerationChange) => void;
  facetReplaced: () => void;
}>;

const SERVING_INSTANCE_KEY = "serving-instance";

export class Generations {
  readonly #storage: DurableObjectStorage;
  readonly #sql: SqlStorage;
  readonly #compatibility: string;
  readonly #ports: GenerationPorts;

  constructor(storage: DurableObjectStorage, compatibility: string, ports: GenerationPorts) {
    this.#storage = storage;
    this.#ports = ports;
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
          epoch INTEGER NOT NULL CHECK (epoch >= 0),
          serving_instance INTEGER NOT NULL DEFAULT 0 CHECK (serving_instance >= 0)
        );
        INSERT INTO generation_state (singleton, active_label, proven_label, epoch)
        VALUES (1, NULL, NULL, 0)
        ON CONFLICT (singleton) DO NOTHING;
      `);

      const columns = this.#sql
        .exec<{ name: string }>("PRAGMA table_info(generation_state)")
        .toArray();

      if (!columns.some(({ name }) => name === "serving_instance")) {
        this.#sql.exec(
          "ALTER TABLE generation_state ADD COLUMN serving_instance INTEGER NOT NULL DEFAULT 0 CHECK (serving_instance >= 0)",
        );
        this.#sql.exec(
          "UPDATE generation_state SET serving_instance = ? WHERE singleton = 1",
          storage.kv.get<number>(SERVING_INSTANCE_KEY) ?? 0,
        );
        storage.kv.delete(SERVING_INSTANCE_KEY);
      }
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

  settled(run: Settlement): void {
    this.#run(() => {
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

  servingInstance(): number {
    return this.#selection().instance;
  }

  active(): ActiveGeneration {
    const { serving, epoch } = this.#selection();
    const current = serving.active === null ? undefined : this.#generation(serving.active);

    return { generation: current === undefined ? undefined : wireGeneration(current), epoch };
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
          this.#ports.changed({
            kind,
            actor,
            epoch,
            outcome,
            errorCode,
            record: wireRecord(changed),
          });
        }
      },
      ReplaceFacet: ({ kind, label, epoch }) => {
        logEvent("info", `generation.${kind}`, { label, epoch });
        this.#ports.facetReplaced();
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
      "UPDATE generation_state SET active_label = ?, proven_label = ?, epoch = ?, serving_instance = ? WHERE singleton = 1",
      row.active_label,
      row.proven_label,
      row.epoch,
      row.serving_instance,
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
