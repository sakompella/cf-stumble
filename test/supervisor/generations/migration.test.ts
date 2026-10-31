import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { FACET_COMPATIBILITY } from "../../../src/facet-compatibility.js";
import { afterEach, expect, test } from "vitest";
import { Generations } from "../../../src/supervisor/generations.js";
import { label } from "./fixtures.js";

const LEGACY_SCHEMA = `
  DROP TABLE generation_state;
  DROP TABLE generations;
  CREATE TABLE generations (
    label INTEGER PRIMARY KEY CHECK (label >= 0),
    harness_commit TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL CHECK (status IN ('candidate', 'ready', 'failed'))
  );
  CREATE TABLE generation_state (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    active_label INTEGER REFERENCES generations(label),
    epoch INTEGER NOT NULL CHECK (epoch >= 0),
    activation_id INTEGER NOT NULL CHECK (activation_id >= 0)
  );
  CREATE TABLE active_generation_history (
    label INTEGER PRIMARY KEY REFERENCES generations(label)
  );
  INSERT INTO generations (label, harness_commit, status) VALUES
    (0, '${"a".repeat(40)}', 'ready'),
    (1, '${"b".repeat(40)}', 'ready'),
    (2, '${"c".repeat(40)}', 'ready');
  INSERT INTO generation_state (singleton, active_label, epoch, activation_id) VALUES (1, 2, 9, 3);
  INSERT INTO active_generation_history (label) VALUES (0), (2);
`;

afterEach(async () => {
  await reset();
});

test("a Supervisor written by the activation-history schema keeps its active generation and its history, with no recorded facet compatibility", async () => {
  const outcome = await runInDurableObject(
    env.SUPERVISOR.getByName("generations-legacy-schema"),
    (_instance, state) => {
      state.storage.sql.exec(LEGACY_SCHEMA);

      const migrated = new Generations(state.storage, FACET_COMPATIBILITY);
      const active = migrated.active();
      const reopened = new Generations(state.storage, FACET_COMPATIBILITY);

      const tables = state.storage.sql
        .exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%generation%' ORDER BY name",
        )
        .toArray()
        .map((row) => row.name);

      return {
        active,
        tables,
        neverActive: reopened.activate({ kind: "rollback", label: label(1), observedEpoch: 9 }),
        rolledBack: reopened.activate({ kind: "rollback", label: label(0), observedEpoch: 9 }),
      };
    },
  );

  expect(outcome.active).toEqual({
    generation: { label: 2, harnessCommit: "c".repeat(40), status: "ready" },
    epoch: 9,
  });
  expect(outcome.tables).toEqual(["generation_state", "generations"]);
  expect(outcome.neverActive).toEqual({ ok: false, problem: { code: "not-previously-active" } });
  expect(
    outcome.rolledBack,
    "a row checked before compatibility was recorded must be re-prepared first",
  ).toEqual({ ok: false, problem: { code: "facet-compatibility-mismatch" } });
});

const COMPATIBILITY_COLUMN_SCHEMA = `
  DROP TABLE generation_state;
  DROP TABLE generations;
  CREATE TABLE generations (
    label INTEGER PRIMARY KEY CHECK (label >= 0),
    harness_commit TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL CHECK (status IN ('candidate', 'ready', 'failed')),
    was_active INTEGER NOT NULL DEFAULT 0 CHECK (was_active IN (0, 1)),
    pi_durable_version TEXT
  );
  CREATE TABLE generation_state (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    active_label INTEGER REFERENCES generations(label),
    epoch INTEGER NOT NULL CHECK (epoch >= 0)
  );
  INSERT INTO generations (label, harness_commit, status, was_active, pi_durable_version) VALUES
    (0, '${"a".repeat(40)}', 'ready', 1, '1.4.0'),
    (1, '${"b".repeat(40)}', 'ready', 1, '${FACET_COMPATIBILITY}');
  INSERT INTO generation_state (singleton, active_label, epoch) VALUES (1, 1, 4);
`;

test("the Pi Durable version column becomes facet_compatibility in place and its values stop matching", async () => {
  const outcome = await runInDurableObject(
    env.SUPERVISOR.getByName("generations-version-column"),
    (_instance, state) => {
      state.storage.sql.exec(COMPATIBILITY_COLUMN_SCHEMA);

      const reopened = new Generations(state.storage, FACET_COMPATIBILITY);

      const columns = state.storage.sql
        .exec<{ name: string }>("SELECT name FROM pragma_table_info('generations')")
        .toArray()
        .map((column) => column.name);

      const recorded = state.storage.sql
        .exec<{ label: number; facet_compatibility: string }>(
          "SELECT label, facet_compatibility FROM generations ORDER BY label",
        )
        .toArray();

      return {
        columns,
        recorded,
        oldValue: reopened.activate({ kind: "rollback", label: label(0), observedEpoch: 4 }),
        currentValue: reopened.activate({ kind: "rollback", label: label(1), observedEpoch: 4 }),
      };
    },
  );

  expect(outcome.columns).toContain("facet_compatibility");
  expect(outcome.columns).not.toContain("pi_durable_version");
  expect(outcome.recorded).toEqual([
    { label: 0, facet_compatibility: "1.4.0" },
    { label: 1, facet_compatibility: FACET_COMPATIBILITY },
  ]);
  expect(outcome.oldValue).toEqual({
    ok: false,
    problem: { code: "facet-compatibility-mismatch" },
  });
  expect(outcome.currentValue).toMatchObject({ ok: true, outcome: { effect: "no-op" } });
});
