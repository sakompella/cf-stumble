export type ReconnectReason = "refresh-refused" | "provider-refused" | "missing-scope";

export type StoredConnection =
  | Readonly<{
      state: "connected";
      accessToken: string;
      refreshToken: string;
      expiresAt: number;
      clientId: string;
    }>
  | Readonly<{ state: "needs-reconnect"; reason: ReconnectReason }>;

export type StoredUsageLimit = Readonly<{ reachedAt: number; limitedUntil: number | null }>;

export type StoredLogin = Readonly<{
  attemptId: string;
  state: string;
  verifier: string;
  authorizeUrl: string;
  expiresAt: number;
}>;

export type StoredGrant = Readonly<{
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  clientId: string;
}>;

type ConnectionRow = {
  readonly status: string;
  readonly reconnect_reason: string | null;
  readonly access_token: string;
  readonly refresh_token: string;
  readonly expires_at: number;
  readonly client_id: string;
};

type LoginRow = {
  readonly attempt_id: string;
  readonly state: string;
  readonly verifier: string;
  readonly authorize_url: string;
  readonly expires_at: number;
};

function reconnectReason(value: string | null): ReconnectReason {
  return value === "refresh-refused" || value === "missing-scope" ? value : "provider-refused";
}

export class CodexLoginCredentialStore {
  private readonly sql: SqlStorage;

  constructor(storage: DurableObjectStorage) {
    this.sql = storage.sql;

    for (const table of ["connection", "login", "usage_limit", "host"]) {
      const legacy = this.sql
        .exec(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
          `chatgpt_${table}`,
        )
        .toArray();

      if (legacy.length > 0)
        this.sql.exec(`ALTER TABLE chatgpt_${table} RENAME TO codex_login_${table}`);
    }

    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS codex_login_connection (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        status TEXT NOT NULL CHECK (status IN ('connected', 'needs-reconnect')),
        reconnect_reason TEXT,
        access_token TEXT NOT NULL,
        refresh_token TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        client_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS codex_login_login (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        attempt_id TEXT NOT NULL,
        state TEXT NOT NULL,
        verifier TEXT NOT NULL,
        authorize_url TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS codex_login_usage_limit (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        reached_at INTEGER NOT NULL,
        limited_until INTEGER
      );
      CREATE TABLE IF NOT EXISTS codex_login_host (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        agent_host_id TEXT NOT NULL
      );
    `);
  }

  connection(): StoredConnection | undefined {
    const row = this.sql
      .exec<ConnectionRow>(
        `SELECT status, reconnect_reason, access_token, refresh_token, expires_at, client_id
         FROM codex_login_connection WHERE id = 1`,
      )
      .toArray()[0];

    if (row === undefined) return undefined;

    return row.status === "connected"
      ? {
          state: "connected",
          accessToken: row.access_token,
          refreshToken: row.refresh_token,
          expiresAt: row.expires_at,
          clientId: row.client_id,
        }
      : { state: "needs-reconnect", reason: reconnectReason(row.reconnect_reason) };
  }

  connect(grant: StoredGrant, now: number): void {
    this.clearUsageLimit();
    this.sql.exec(
      `INSERT OR REPLACE INTO codex_login_connection
         (id, status, reconnect_reason, access_token, refresh_token, expires_at, client_id, updated_at)
       VALUES (1, 'connected', NULL, ?, ?, ?, ?, ?)`,
      grant.accessToken,
      grant.refreshToken,
      grant.expiresAt,
      grant.clientId,
      now,
    );
  }

  replaceRefreshed(redeemed: string, grant: Omit<StoredGrant, "clientId">, now: number): boolean {
    return (
      this.sql
        .exec(
          `UPDATE codex_login_connection
           SET access_token = ?, refresh_token = ?, expires_at = ?, updated_at = ?
           WHERE id = 1 AND status = 'connected' AND refresh_token = ?
           RETURNING id`,
          grant.accessToken,
          grant.refreshToken,
          grant.expiresAt,
          now,
          redeemed,
        )
        .toArray().length > 0
    );
  }

  markNeedsReconnect(accessToken: string, reason: ReconnectReason, now: number): void {
    this.sql.exec(
      `UPDATE codex_login_connection SET status = 'needs-reconnect', reconnect_reason = ?, updated_at = ?
       WHERE id = 1 AND access_token = ?`,
      reason,
      now,
      accessToken,
    );
  }

  disconnect(): void {
    this.sql.exec("DELETE FROM codex_login_connection");
    this.sql.exec("DELETE FROM codex_login_login");
    this.clearUsageLimit();
  }

  usageLimit(): StoredUsageLimit | undefined {
    const row = this.sql
      .exec<{ readonly reached_at: number; readonly limited_until: number | null }>(
        "SELECT reached_at, limited_until FROM codex_login_usage_limit WHERE id = 1",
      )
      .toArray()[0];

    return row === undefined
      ? undefined
      : { reachedAt: row.reached_at, limitedUntil: row.limited_until };
  }

  markUsageLimited(accessToken: string, limit: StoredUsageLimit): void {
    this.sql.exec(
      `INSERT OR REPLACE INTO codex_login_usage_limit (id, reached_at, limited_until)
       SELECT 1, ?, ? FROM codex_login_connection
       WHERE id = 1 AND status = 'connected' AND access_token = ?`,
      limit.reachedAt,
      limit.limitedUntil,
      accessToken,
    );
  }

  clearUsageLimit(): void {
    this.sql.exec("DELETE FROM codex_login_usage_limit");
  }

  login(): StoredLogin | undefined {
    const row = this.sql
      .exec<LoginRow>(
        `SELECT attempt_id, state, verifier, authorize_url, expires_at FROM codex_login_login WHERE id = 1`,
      )
      .toArray()[0];

    return row === undefined
      ? undefined
      : {
          attemptId: row.attempt_id,
          state: row.state,
          verifier: row.verifier,
          authorizeUrl: row.authorize_url,
          expiresAt: row.expires_at,
        };
  }

  startLogin(login: StoredLogin): void {
    this.sql.exec(
      `INSERT OR REPLACE INTO codex_login_login (id, attempt_id, state, verifier, authorize_url, expires_at)
       VALUES (1, ?, ?, ?, ?, ?)`,
      login.attemptId,
      login.state,
      login.verifier,
      login.authorizeUrl,
      login.expiresAt,
    );
  }

  clearLogin(): void {
    this.sql.exec("DELETE FROM codex_login_login");
  }

  agentHostId(): string {
    this.sql.exec(
      "INSERT OR IGNORE INTO codex_login_host (id, agent_host_id) VALUES (1, ?)",
      crypto.randomUUID(),
    );

    return this.sql
      .exec<{ readonly agent_host_id: string }>(
        "SELECT agent_host_id FROM codex_login_host WHERE id = 1",
      )
      .one().agent_host_id;
  }
}
