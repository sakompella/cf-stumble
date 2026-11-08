import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import { CodexLoginCredentialStore } from "../../src/codex-login/index.js";

afterEach(async () => {
  await reset();
});

test("a grant stored under the old ChatGPT tables is read and moved to the codex-login tables", async () => {
  await runInDurableObject(
    env.SUPERVISOR.getByName("codex-login-migration"),
    (_instance, state) => {
      const sql = state.storage.sql;

      sql.exec(`
      DROP TABLE codex_login_connection;
      DROP TABLE codex_login_login;
      DROP TABLE codex_login_usage_limit;
      DROP TABLE codex_login_host;
      CREATE TABLE chatgpt_connection (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        status TEXT NOT NULL CHECK (status IN ('connected', 'needs-reconnect')),
        reconnect_reason TEXT,
        access_token TEXT NOT NULL,
        refresh_token TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        client_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE chatgpt_host (id INTEGER PRIMARY KEY CHECK (id = 1), agent_host_id TEXT NOT NULL);
      INSERT INTO chatgpt_connection VALUES (1, 'connected', NULL, 'access-OLD', 'refresh-OLD', 5, 'client-OLD', 1);
      INSERT INTO chatgpt_host VALUES (1, 'host-OLD');
    `);

      const store = new CodexLoginCredentialStore(state.storage);

      expect(store.connection()).toEqual({
        state: "connected",
        accessToken: "access-OLD",
        refreshToken: "refresh-OLD",
        expiresAt: 5,
        clientId: "client-OLD",
      });
      expect(store.agentHostId()).toBe("host-OLD");
      expect(
        sql.exec("SELECT name FROM sqlite_master WHERE name LIKE 'chatgpt_%'").toArray(),
      ).toEqual([]);
      expect(new CodexLoginCredentialStore(state.storage).connection()?.state).toBe("connected");
    },
  );
});
