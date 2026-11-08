import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import { ChatGPTCredentialStore } from "../../src/chatgpt/index.js";

afterEach(async () => {
  await reset();
});

const CONNECTION = `(
  id INTEGER PRIMARY KEY CHECK (id = 1),
  status TEXT NOT NULL CHECK (status IN ('connected', 'needs-reconnect')),
  reconnect_reason TEXT,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  client_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL
)`;

const GRANT = {
  state: "connected",
  accessToken: "access-KEPT",
  refreshToken: "refresh-KEPT",
  expiresAt: 5,
  clientId: "client-KEPT",
};

test("a grant stored under the codex_login tables of the reverted rename is restored to the chatgpt tables", async () => {
  await runInDurableObject(env.SUPERVISOR.getByName("rename-undo"), (_instance, state) => {
    const sql = state.storage.sql;

    sql.exec(`
      DROP TABLE chatgpt_connection;
      DROP TABLE chatgpt_login;
      DROP TABLE chatgpt_usage_limit;
      DROP TABLE chatgpt_host;
      CREATE TABLE codex_login_connection ${CONNECTION};
      CREATE TABLE codex_login_host (id INTEGER PRIMARY KEY CHECK (id = 1), agent_host_id TEXT NOT NULL);
      INSERT INTO codex_login_connection VALUES (1, 'connected', NULL, 'access-KEPT', 'refresh-KEPT', 5, 'client-KEPT', 1);
      INSERT INTO codex_login_host VALUES (1, 'host-KEPT');
    `);

    const store = new ChatGPTCredentialStore(state.storage);

    expect(store.connection()).toEqual(GRANT);
    expect(store.agentHostId()).toBe("host-KEPT");
    expect(
      sql.exec("SELECT name FROM sqlite_master WHERE name LIKE 'codex_login_%'").toArray(),
    ).toEqual([]);
  });
});

test("a database that never had codex_login tables is left as it is", async () => {
  await runInDurableObject(env.SUPERVISOR.getByName("rename-fresh"), (_instance, state) => {
    const sql = state.storage.sql;

    sql.exec(
      "INSERT INTO chatgpt_connection VALUES (1, 'connected', NULL, 'access-KEPT', 'refresh-KEPT', 5, 'client-KEPT', 1)",
    );

    expect(new ChatGPTCredentialStore(state.storage).connection()).toEqual(GRANT);
    expect(
      sql.exec("SELECT name FROM sqlite_master WHERE name LIKE 'codex_login_%'").toArray(),
    ).toEqual([]);
  });
});
