/// <reference types="@cloudflare/workers-types" />

import { Result } from "better-result";
import type { HarnessCommit } from "../../harness-commit.js";
import { ActivationHistory } from "./activation-history.js";
import { PreparationChecks } from "./preparation-checks.js";
import type { PreparationCheck } from "./preparation-checks.js";
import {
  assertNever,
  decideActivation,
  decidePreparationCheck,
  type GenerationState,
} from "./decisions.js";
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

/**
 * Owns the generation registry and the singleton control state. Every mutating method is an
 * imperative shell: it reads the plain values it needs, calls a pure decider in ./decisions.ts,
 * and applies the effects that decision names. All three run inside one Durable Object transaction
 * (labelInTransaction and activateInTransaction under the caller's; recordPreparationCheck opens
 * its own), which is what makes the deciders' current-plus-one arithmetic safe.
 */
export class Generations {
  private readonly storage: DurableObjectStorage;
  private readonly sql: SqlStorage;
  private readonly preparationChecks: PreparationChecks;
  private readonly activationHistory: ActivationHistory;

  constructor(storage: DurableObjectStorage) {
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
  }

  labelInTransaction(harnessCommit: HarnessCommit) {
    const existing = this.generationByCommit(harnessCommit);
    const state = this.readState();
    if (existing !== undefined) {
      return { generation: existing, epoch: state.epoch };
    }

    const label = this.nextLabel();
    this.sql.exec(
      "INSERT INTO generations (label, harness_commit, status) VALUES (?, ?, 'candidate')",
      label,
      harnessCommit,
    );
    const epoch = state.epoch + 1;
    this.writeEpoch(epoch);

    const generation: Generation = { label, harnessCommit, status: "candidate" };
    return { generation, epoch };
  }

  recordPreparationCheck(
    label: GenerationLabel,
    outcome: PreparationCheckOutcome,
  ): PreparationCheckResult {
    return this.transaction(() => {
      const decision = decidePreparationCheck(
        label,
        outcome,
        this.generationByLabel(label),
        this.readState(),
      );
      switch (decision.kind) {
        case "rejected":
          return Result.err(decision.problem);
        case "record":
          this.preparationChecks.record(label, decision.outcome);
          if (decision.statusUpdate !== undefined) {
            this.sql.exec(
              "UPDATE generations SET status = ? WHERE label = ?",
              decision.statusUpdate,
              label,
            );
          }
          this.writeEpoch(decision.nextEpoch);
          return Result.ok({
            generation: decision.generation,
            epoch: decision.nextEpoch,
            effect: decision.effect,
          });
        default:
          return assertNever(decision);
      }
    });
  }

  activateInTransaction(label: GenerationLabel): ActivationResult {
    const decision = decideActivation(label, this.generationByLabel(label), this.readState());
    switch (decision.kind) {
      case "rejected":
        return Result.err(decision.problem);
      case "no-op":
        return Result.ok({
          generation: decision.generation,
          epoch: decision.epoch,
          effect: "no-op",
        });
      case "activate":
        this.applyActivation(label, decision.nextEpoch, decision.nextActivationId);
        return Result.ok({
          generation: decision.generation,
          epoch: decision.nextEpoch,
          effect: "activated",
        });
      default:
        return assertNever(decision);
    }
  }

  active(): ActiveGeneration {
    const state = this.readState();
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

  private nextLabel(): GenerationLabel {
    return generationLabelFromPersistence(
      this.sql
        .exec<{ readonly label: number }>(
          "SELECT COALESCE(MAX(label), -1) + 1 AS label FROM generations",
        )
        .one().label,
      "next generation label",
    );
  }

  private readState(): GenerationState {
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

  private writeEpoch(epoch: number): void {
    this.sql.exec("UPDATE generation_state SET epoch = ? WHERE singleton = 1", epoch);
  }

  private applyActivation(label: GenerationLabel, epoch: number, activationId: number): void {
    this.sql.exec(
      "UPDATE generation_state SET active_label = ?, epoch = ?, activation_id = ? WHERE singleton = 1",
      label,
      epoch,
      activationId,
    );
    this.activationHistory.recordActive(label);
    this.activationHistory.record(label, activationId);
  }
}
