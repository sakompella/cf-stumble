/// <reference types="@cloudflare/workers-types" />

import { Result } from "better-result";
import { parseHarnessCommit, type HarnessCommit } from "../../harness-commit.js";
import { invariant } from "../../invariant.js";
import { ActivationHistory } from "./activation-history.js";
import { PreparationChecks } from "./preparation-checks.js";
import type { PreparationCheck } from "./preparation-checks.js";
import {
  type ActivationResult,
  type ActiveGeneration,
  type Generation,
  type GenerationLabel,
  type PreparationCheckOutcome,
  type PreparationCheckResult,
} from "./generation.js";
import { generationFromRow, generationLabelFromPersistence } from "./row.js";
import type { GenerationRow } from "./row.js";

export { parseGenerationLabel } from "./generation.js";
export type {
  ActivationResult,
  ActiveGeneration,
  Generation,
  GenerationLabel,
  GenerationStatus,
  PreparationCheckProblem,
  PreparationCheckOutcome,
  PreparationCheckResult,
} from "./generation.js";
export type { PreparationCheck } from "./preparation-checks.js";

type StateRow = {
  readonly active_label: number | null;
  readonly epoch: number;
  readonly activation_id: number;
};

type State = {
  readonly activeLabel: GenerationLabel | undefined;
  readonly epoch: number;
  readonly activationId: number;
};

export class Generations {
  private readonly storage: DurableObjectStorage;
  private readonly sql: SqlStorage;
  private readonly preparationChecks: PreparationChecks;
  private readonly activationHistory: ActivationHistory;

  constructor(storage: DurableObjectStorage, fixtureHarnessCommit: string) {
    const fixtureCommit = parseHarnessCommit(fixtureHarnessCommit);
    invariant(fixtureCommit !== undefined, "invalid fixture harness commit");

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
      fixtureCommit,
    );
  }

  labelInTransaction(harnessCommit: HarnessCommit) {
    const existing = this.generationByCommit(harnessCommit);
    if (existing !== undefined) {
      return { generation: existing, epoch: this.state().epoch };
    }

    const nextLabel = generationLabelFromPersistence(
      this.sql
        .exec<{ readonly label: number }>(
          "SELECT COALESCE(MAX(label), -1) + 1 AS label FROM generations",
        )
        .one().label,
      "next generation label",
    );
    this.sql.exec(
      "INSERT INTO generations (label, harness_commit, status) VALUES (?, ?, 'candidate')",
      nextLabel,
      harnessCommit,
    );
    const epoch = this.incrementEpoch();

    const generation: Generation = { label: nextLabel, harnessCommit, status: "candidate" };
    return { generation, epoch };
  }

  recordPreparationCheck(
    label: GenerationLabel,
    outcome: PreparationCheckOutcome,
  ): PreparationCheckResult {
    if (outcome !== "passed" && outcome !== "failed") {
      return Result.err({ code: "invalid-preparation-check-outcome" });
    }

    return this.transaction(() => {
      const generation = this.generationByLabel(label);
      if (generation === undefined) {
        return Result.err({ code: "unknown-generation", label });
      }

      const status = outcome === "passed" ? "ready" : "failed";

      if (generation.status !== "candidate") {
        if (generation.status !== status) {
          return Result.err({
            code: "contradicts-recorded-outcome",
            label,
            recorded: generation.status,
          });
        }

        this.preparationChecks.record(label, outcome);
        const epoch = this.incrementEpoch();
        return Result.ok({ generation, epoch, effect: "no-op" });
      }

      this.preparationChecks.record(label, outcome);
      this.sql.exec("UPDATE generations SET status = ? WHERE label = ?", status, label);
      const epoch = this.incrementEpoch();

      return Result.ok({
        generation: { ...generation, status },
        epoch,
        effect: "recorded",
      });
    });
  }

  activateInTransaction(label: GenerationLabel): ActivationResult {
    const generation = this.generationByLabel(label);
    if (generation === undefined) {
      return Result.err({ code: "unknown-generation", label });
    }

    if (generation.status !== "ready") {
      return Result.err({ code: "not-ready", label });
    }

    const state = this.state();
    if (state.activeLabel === label) {
      return Result.ok({
        generation,
        epoch: state.epoch,
        effect: "no-op",
      });
    }

    this.sql.exec("UPDATE generation_state SET active_label = ? WHERE singleton = 1", label);
    const epoch = this.incrementEpoch();
    const activationId = this.incrementActivationId();
    this.activationHistory.recordActive(label);
    this.activationHistory.record(label, activationId);

    return Result.ok({ generation, epoch, effect: "activated" });
  }

  active(): ActiveGeneration {
    const state = this.state();
    return {
      generation:
        state.activeLabel === undefined ? undefined : this.generationByLabel(state.activeLabel),
      epoch: state.epoch,
      activationId: state.activeLabel === undefined ? undefined : state.activationId,
    };
  }

  byLabel(label: GenerationLabel): Generation | undefined {
    return this.generationByLabel(label);
  }

  all(): readonly Generation[] {
    return this.sql
      .exec<GenerationRow>(
        "SELECT label, harness_commit, status FROM generations ORDER BY label ASC",
      )
      .toArray()
      .map((row) => generationFromRow(row));
  }

  latestPreparationCheck(label: GenerationLabel): PreparationCheck | undefined {
    return this.preparationChecks.latest(label);
  }

  latestPreparationCheckId(): number {
    return this.preparationChecks.latestId();
  }

  latestActivationId(label: GenerationLabel): number | undefined {
    return this.activationHistory.latestId(label);
  }

  preparationCheckHistory(label: GenerationLabel): readonly PreparationCheck[] {
    return this.preparationChecks.all(label);
  }

  hasBeenActive(label: GenerationLabel): boolean {
    return this.activationHistory.hasBeenActive(label);
  }

  transaction<T>(operation: () => T): T {
    return this.storage.transactionSync(operation);
  }

  private generationByCommit(harnessCommit: HarnessCommit): Generation | undefined {
    const row = this.sql
      .exec<GenerationRow>(
        "SELECT label, harness_commit, status FROM generations WHERE harness_commit = ?",
        harnessCommit,
      )
      .toArray()[0];

    return row === undefined ? undefined : generationFromRow(row);
  }

  private generationByLabel(label: GenerationLabel): Generation | undefined {
    const row = this.sql
      .exec<GenerationRow>(
        "SELECT label, harness_commit, status FROM generations WHERE label = ?",
        label,
      )
      .toArray()[0];

    return row === undefined ? undefined : generationFromRow(row);
  }

  private state(): State {
    const row = this.sql
      .exec<StateRow>(
        "SELECT active_label, epoch, activation_id FROM generation_state WHERE singleton = 1",
      )
      .one();

    return {
      activeLabel:
        row.active_label === null
          ? undefined
          : generationLabelFromPersistence(row.active_label, "active generation label"),
      epoch: row.epoch,
      activationId: row.activation_id,
    };
  }

  private incrementEpoch(): number {
    this.sql.exec("UPDATE generation_state SET epoch = epoch + 1 WHERE singleton = 1");
    return this.state().epoch;
  }

  private incrementActivationId(): number {
    this.sql.exec(
      "UPDATE generation_state SET activation_id = activation_id + 1 WHERE singleton = 1",
    );
    return this.state().activationId;
  }
}
