import { parseGenerationLabel, type GenerationLabel } from "./generation-types.js";

export type PreparationCheck = {
  readonly id: number;
  readonly generationLabel: GenerationLabel;
  readonly outcome: "passed" | "failed";
};

type PreparationCheckRow = {
  readonly id: number;
  readonly generation_label: number;
  readonly outcome: string;
};

export class PreparationChecks {
  private readonly sql: SqlStorage;

  constructor(storage: DurableObjectStorage) {
    this.sql = storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS preparation_checks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        generation_label INTEGER NOT NULL,
        outcome TEXT NOT NULL CHECK (outcome IN ('passed', 'failed'))
      );
    `);
  }

  record(generationLabel: GenerationLabel, outcome: PreparationCheck["outcome"]): PreparationCheck {
    const row = this.sql
      .exec<PreparationCheckRow>(
        `INSERT INTO preparation_checks (generation_label, outcome)
         VALUES (?, ?)
         RETURNING id, generation_label, outcome`,
        generationLabel,
        outcome,
      )
      .one();

    return preparationCheckFromRow(row);
  }

  latestPass(generationLabel: GenerationLabel): PreparationCheck | undefined {
    const row = this.sql
      .exec<PreparationCheckRow>(
        `SELECT id, generation_label, outcome
         FROM preparation_checks
         WHERE generation_label = ? AND outcome = 'passed'
         ORDER BY id DESC
         LIMIT 1`,
        generationLabel,
      )
      .toArray()[0];

    return row === undefined ? undefined : preparationCheckFromRow(row);
  }

  all(generationLabel: GenerationLabel): readonly PreparationCheck[] {
    return this.sql
      .exec<PreparationCheckRow>(
        `SELECT id, generation_label, outcome
         FROM preparation_checks
         WHERE generation_label = ?
         ORDER BY id ASC`,
        generationLabel,
      )
      .toArray()
      .map((row) => preparationCheckFromRow(row));
  }
}

function preparationCheckFromRow(row: PreparationCheckRow): PreparationCheck {
  const generationLabel = parseGenerationLabel(row.generation_label);
  if (generationLabel === undefined || (row.outcome !== "passed" && row.outcome !== "failed")) {
    throw new Error(`invalid persisted preparation check ${row.id}`);
  }

  return { id: row.id, generationLabel, outcome: row.outcome };
}
