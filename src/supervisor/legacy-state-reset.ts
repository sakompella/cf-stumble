import { logEvent, type LogFields } from "../diagnostics.js";

// One-time compensation for 0e6bdf8 and 768d2e3, which dropped the handling of connected_projects
// rows stored under the project id rule before 8d0469f and of project_threads tables created
// before turn_holder_id. Nobody can read production's Supervisor SQLite to prove it holds neither,
// so the first construction after this deploy drops the old state instead. Delete this module and
// its constructor call once production has run it; the marker table can stay.

/** Exists once the reset has run, so a later construction keeps whatever was written since. */
const MARKER_TABLE = "legacy_state_reset";

/**
 * How the workspace got its GitHub credential. The credential itself lives in the Workspace Host,
 * so keeping these rows is what spares the owner a second sign-in.
 */
const KEPT_TABLES: ReadonlySet<string> = new Set([
  "github_authorization",
  "github_connection",
  MARKER_TABLE,
]);

type DroppedTable = Readonly<{ name: string; rows: number }>;

function quotedIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** Every table a store created, which leaves out SQLite's own and the platform's `_cf_` tables. */
function supervisorTables(sql: SqlStorage): readonly string[] {
  return sql
    .exec<{ readonly name: string }>(
      String.raw`SELECT name FROM sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite\_%' ESCAPE '\' AND name NOT LIKE '\_cf\_%' ESCAPE '\'
       ORDER BY name`,
    )
    .toArray()
    .map((row) => row.name);
}

function dropLegacyTables(storage: DurableObjectStorage): readonly DroppedTable[] {
  const { sql } = storage;

  return storage.transactionSync(() => {
    sql.exec(`CREATE TABLE IF NOT EXISTS ${MARKER_TABLE} (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      reset_at INTEGER NOT NULL
    )`);

    if (sql.exec(`SELECT id FROM ${MARKER_TABLE}`).toArray().length > 0) {
      return [];
    }

    const dropped = supervisorTables(sql)
      .filter((name) => !KEPT_TABLES.has(name))
      .map((name) => ({
        name,
        rows: sql
          .exec<{ readonly rows: number }>(`SELECT COUNT(*) AS rows FROM ${quotedIdentifier(name)}`)
          .one().rows,
      }));

    // Tables drop in name order, and a table that references generations may sort after it, so
    // the foreign key checks wait for the commit, when every referencing table is gone too.
    sql.exec("PRAGMA defer_foreign_keys = ON");

    for (const { name } of dropped) {
      sql.exec(`DROP TABLE ${quotedIdentifier(name)}`);
    }

    sql.exec(`INSERT INTO ${MARKER_TABLE} (id, reset_at) VALUES (1, ?)`, Date.now());

    return dropped;
  });
}

/**
 * Drop every Supervisor table except the GitHub connection tables, once per Durable Object. Run it
 * before any store opens its tables; the stores then recreate them empty. It reads and writes only
 * this object's SQLite: no Workspace Host call, no workspace file, R2 object, or KV key.
 */
export function resetLegacySupervisorStateOnce(storage: DurableObjectStorage): void {
  const dropped = dropLegacyTables(storage);

  if (dropped.length === 0) {
    return;
  }

  const rowCounts: LogFields = Object.fromEntries(
    dropped.map(({ name, rows }) => [`rows.${name}`, rows]),
  );

  logEvent("info", "supervisor.legacy-state-reset", {
    tables: dropped.length,
    rows: dropped.reduce((total, table) => total + table.rows, 0),
    ...rowCounts,
  });
}
