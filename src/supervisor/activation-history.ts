import type { GenerationLabel } from "./generation-types.js";

type ActivationHistoryRow = {
  readonly activation_id: number;
};

export class ActivationHistory {
  private readonly sql: SqlStorage;

  constructor(storage: DurableObjectStorage) {
    this.sql = storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS active_generation_history (
        label INTEGER PRIMARY KEY REFERENCES generations(label)
      );
      CREATE TABLE IF NOT EXISTS generation_activation_history (
        activation_id INTEGER PRIMARY KEY CHECK (activation_id > 0),
        generation_label INTEGER NOT NULL REFERENCES generations(label)
      );
    `);
  }

  record(generationLabel: GenerationLabel, activationId: number): void {
    this.sql.exec(
      "INSERT INTO generation_activation_history (activation_id, generation_label) VALUES (?, ?)",
      activationId,
      generationLabel,
    );
  }

  recordActive(generationLabel: GenerationLabel): void {
    this.sql.exec(
      "INSERT INTO active_generation_history (label) VALUES (?) ON CONFLICT DO NOTHING",
      generationLabel,
    );
  }

  latestId(generationLabel: GenerationLabel): number | undefined {
    return this.sql
      .exec<ActivationHistoryRow>(
        `SELECT activation_id
         FROM generation_activation_history
         WHERE generation_label = ?
         ORDER BY activation_id DESC
         LIMIT 1`,
        generationLabel,
      )
      .toArray()[0]?.activation_id;
  }

  hasBeenActive(generationLabel: GenerationLabel): boolean {
    return (
      this.sql
        .exec<{ readonly label: number }>(
          "SELECT label FROM active_generation_history WHERE label = ?",
          generationLabel,
        )
        .toArray()[0] !== undefined
    );
  }
}
