import type { GenerationLabel } from "./generation.js";

export class ActivationHistory {
  private readonly sql: SqlStorage;

  constructor(storage: DurableObjectStorage) {
    this.sql = storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS active_generation_history (
        label INTEGER PRIMARY KEY REFERENCES generations(label)
      );
    `);
  }

  recordActive(generationLabel: GenerationLabel): void {
    this.sql.exec(
      "INSERT INTO active_generation_history (label) VALUES (?) ON CONFLICT DO NOTHING",
      generationLabel,
    );
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
