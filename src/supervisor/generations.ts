/// <reference types="@cloudflare/workers-types" />

import { HarnessCommitId } from "../harness-commit.js";
import { ActivationHistory } from "./activation-history.js";
import { PreparationChecks } from "./preparation-checks.js";
import type { PreparationCheck } from "./preparation-checks.js";
import type {
  ActivationResult,
  ActiveGeneration,
  Generation,
  GenerationStatus,
  LabelGenerationResult,
  PreparationCheckOutcome,
  PreparationCheckResult,
} from "./generation-types.js";

export type {
  ActivationResult,
  ActiveGeneration,
  Generation,
  GenerationStatus,
  LabelGenerationResult,
  PreparationCheckOutcome,
  PreparationCheckResult,
} from "./generation-types.js";
export type { PreparationCheck } from "./preparation-checks.js";

type GenerationRow = {
  readonly label: number;
  readonly harness_commit: string;
  readonly status: GenerationStatus;
};

type StateRow = {
  readonly active_label: number | null;
  readonly epoch: number;
  readonly activation_id: number;
};

export class Generations {
  private readonly storage: DurableObjectStorage;
  private readonly sql: SqlStorage;
  private readonly preparationChecks: PreparationChecks;
  private readonly activationHistory: ActivationHistory;

  constructor(storage: DurableObjectStorage, fixtureHarnessCommit: string) {
    this.storage = storage;
    this.sql = storage.sql;
    this.preparationChecks = new PreparationChecks(storage);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS generations (
        label INTEGER PRIMARY KEY CHECK (label >= 0),
        harness_commit TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK (status IN ('candidate', 'ready', 'failed'))
      );
      CREATE TABLE IF NOT EXISTS generation_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        active_label INTEGER REFERENCES generations(label),
        epoch INTEGER NOT NULL CHECK (epoch >= 0),
        activation_id INTEGER NOT NULL CHECK (activation_id >= 0)
      );
      INSERT INTO generation_state (singleton, active_label, epoch, activation_id)
      VALUES (1, NULL, 0, 0)
      ON CONFLICT (singleton) DO NOTHING;
    `);
    this.activationHistory = new ActivationHistory(storage);

    this.sql.exec(
      `INSERT INTO generations (label, harness_commit, status)
       VALUES (0, ?, 'candidate')
       ON CONFLICT DO NOTHING`,
      fixtureHarnessCommit,
    );
  }

  label(harnessCommit: string): LabelGenerationResult {
    return this.transaction(() => this.labelInTransaction(harnessCommit));
  }

  labelInTransaction(harnessCommit: string): LabelGenerationResult {
    const commit = HarnessCommitId.parse(harnessCommit);
    if (commit === undefined) {
      return { ok: false, problem: { code: "invalid-harness-commit", harnessCommit } };
    }

    const existing = this.generationByCommit(commit.value);
    if (existing !== undefined) {
      return { ok: true, generation: existing, epoch: this.state().epoch };
    }

    const nextLabel = this.sql
      .exec<{ readonly label: number }>(
        "SELECT COALESCE(MAX(label), -1) + 1 AS label FROM generations",
      )
      .one().label;
    this.sql.exec(
      "INSERT INTO generations (label, harness_commit, status) VALUES (?, ?, 'candidate')",
      nextLabel,
      commit.value,
    );
    const epoch = this.incrementEpoch();

    return {
      ok: true,
      generation: { label: nextLabel, harnessCommit: commit.value, status: "candidate" },
      epoch,
    };
  }

  recordPreparationCheck(label: number, outcome: PreparationCheckOutcome): PreparationCheckResult {
    if (!isGenerationLabel(label)) {
      return { ok: false, problem: { code: "invalid-generation-label", label } };
    }

    if (outcome !== "passed" && outcome !== "failed") {
      return { ok: false, problem: { code: "invalid-preparation-check-outcome" } };
    }

    return this.transaction(() => {
      const generation = this.generationByLabel(label);
      if (generation === undefined) {
        return { ok: false, problem: { code: "unknown-generation", label } };
      }

      const status = outcome === "passed" ? "ready" : "failed";

      if (generation.status !== "candidate") {
        if (generation.status !== status) {
          return {
            ok: false,
            problem: {
              code: "contradicts-recorded-outcome",
              label,
              recorded: generation.status,
            },
          };
        }

        this.preparationChecks.record(label, outcome);
        return { ok: true, generation, epoch: this.state().epoch, effect: "no-op" };
      }

      this.preparationChecks.record(label, outcome);
      this.sql.exec("UPDATE generations SET status = ? WHERE label = ?", status, label);
      const epoch = this.incrementEpoch();

      return {
        ok: true,
        generation: { ...generation, status },
        epoch,
        effect: "recorded",
      };
    });
  }

  activate(label: number): ActivationResult {
    return this.transaction(() => this.activateInTransaction(label));
  }

  activateInTransaction(label: number): ActivationResult {
    if (!isGenerationLabel(label)) {
      return { ok: false, problem: { code: "invalid-generation-label", label } };
    }

    const generation = this.generationByLabel(label);
    if (generation === undefined) {
      return { ok: false, problem: { code: "unknown-generation", label } };
    }

    if (generation.status !== "ready") {
      return { ok: false, problem: { code: "not-ready", label } };
    }

    const state = this.state();
    if (state.active_label === label) {
      return {
        ok: true,
        generation,
        epoch: state.epoch,
        effect: "no-op",
      };
    }

    this.sql.exec("UPDATE generation_state SET active_label = ? WHERE singleton = 1", label);
    const epoch = this.incrementEpoch();
    const activationId = this.incrementActivationId();
    this.activationHistory.recordActive(label);
    this.activationHistory.record(label, activationId);

    return { ok: true, generation, epoch, effect: "activated" };
  }

  active(): ActiveGeneration {
    const state = this.state();
    return {
      generation:
        state.active_label === null ? undefined : this.generationByLabel(state.active_label),
      epoch: state.epoch,
      activationId: state.active_label === null ? undefined : state.activation_id,
    };
  }

  byLabel(label: number): Generation | undefined {
    return isGenerationLabel(label) ? this.generationByLabel(label) : undefined;
  }

  all(): readonly Generation[] {
    return this.sql
      .exec<GenerationRow>(
        "SELECT label, harness_commit, status FROM generations ORDER BY label ASC",
      )
      .toArray()
      .map((row) => generationFromRow(row));
  }

  latestPreparationCheck(label: number): PreparationCheck | undefined {
    return isGenerationLabel(label) ? this.preparationChecks.latestPass(label) : undefined;
  }

  latestActivationId(label: number): number | undefined {
    return isGenerationLabel(label) ? this.activationHistory.latestId(label) : undefined;
  }

  preparationCheckHistory(label: number): readonly PreparationCheck[] {
    return isGenerationLabel(label) ? this.preparationChecks.all(label) : [];
  }

  hasBeenActive(label: number): boolean {
    return isGenerationLabel(label) && this.activationHistory.hasBeenActive(label);
  }

  transaction<T>(operation: () => T): T {
    return this.storage.transactionSync(operation);
  }

  private generationByCommit(harnessCommit: string): Generation | undefined {
    const row = this.sql
      .exec<GenerationRow>(
        "SELECT label, harness_commit, status FROM generations WHERE harness_commit = ?",
        harnessCommit,
      )
      .toArray()[0];

    return row === undefined ? undefined : generationFromRow(row);
  }

  private generationByLabel(label: number): Generation | undefined {
    const row = this.sql
      .exec<GenerationRow>(
        "SELECT label, harness_commit, status FROM generations WHERE label = ?",
        label,
      )
      .toArray()[0];

    return row === undefined ? undefined : generationFromRow(row);
  }

  private state(): StateRow {
    return this.sql
      .exec<StateRow>(
        "SELECT active_label, epoch, activation_id FROM generation_state WHERE singleton = 1",
      )
      .one();
  }

  private incrementEpoch(): number {
    this.sql.exec("UPDATE generation_state SET epoch = epoch + 1 WHERE singleton = 1");
    return this.state().epoch;
  }

  private incrementActivationId(): number {
    this.sql.exec(
      "UPDATE generation_state SET activation_id = activation_id + 1 WHERE singleton = 1",
    );
    return this.state().activation_id;
  }
}

function generationFromRow(row: GenerationRow): Generation {
  return {
    label: row.label,
    harnessCommit: row.harness_commit,
    status: row.status,
  };
}

function isGenerationLabel(label: number): boolean {
  return Number.isSafeInteger(label) && label >= 0;
}
