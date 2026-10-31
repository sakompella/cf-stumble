import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
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

test("a Supervisor written by the activation-history schema keeps its active generation and its history", async () => {
  const outcome = await runInDurableObject(
    env.SUPERVISOR.getByName("generations-legacy-schema"),
    (_instance, state) => {
      state.storage.sql.exec(LEGACY_SCHEMA);

      const migrated = new Generations(state.storage);
      const active = migrated.active();
      const reopened = new Generations(state.storage);

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
  expect(outcome.rolledBack).toMatchObject({
    ok: true,
    outcome: { kind: "rolled-back", generation: { label: 0 }, epoch: 10, effect: "activated" },
  });
});
