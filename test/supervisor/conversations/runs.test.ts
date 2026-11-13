import { reset, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, expect, test, vi } from "vitest";
import { runAtEntryPoint } from "../../../src/run-entry-point.js";
import { AlarmWriteFailed, ConversationRuns } from "../../../src/supervisor/conversations/runs.js";

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

test("a failing alarm write reaches the entry point as a typed failure", async () => {
  await runInDurableObject(
    env.SUPERVISOR.getByName("runs-alarm-write-failed"),
    (_instance, state) => {
      vi.spyOn(state.storage, "deleteAlarm").mockRejectedValue(new Error("the storage refused"));

      const runs = new ConversationRuns(state.storage);

      return expect(runAtEntryPoint(runs.setAlarm(0))).rejects.toBeInstanceOf(AlarmWriteFailed);
    },
  );
});

test("a runs table from before automatic continues gains the column, and its runs read none", async () => {
  await runInDurableObject(
    env.SUPERVISOR.getByName("runs-continues-column"),
    (_instance, state) => {
      const { sql } = state.storage;

      sql.exec("DROP TABLE conversation_runs");
      sql.exec(`
      CREATE TABLE conversation_runs (
        conversation_id TEXT PRIMARY KEY,
        run INTEGER,
        deadline INTEGER NOT NULL,
        ending TEXT CHECK (ending IN ('cancelled', 'interrupted')),
        instance INTEGER
      )
    `);
      sql.exec("INSERT INTO conversation_runs VALUES ('7', 3, 0, NULL, 1)");

      const runs = new ConversationRuns(state.storage);

      expect(runs.expired(1)).toEqual(["7"]);
      expect(sql.exec("SELECT continues FROM conversation_runs").toArray()).toEqual([
        { continues: 0 },
      ]);
    },
  );
});
