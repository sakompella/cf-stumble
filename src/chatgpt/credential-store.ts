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

export class ChatGPTCredentialStore {
  private readonly sql: SqlStorage;

  constructor(storage: DurableObjectStorage) {
    this.sql = storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS chatgpt_connection (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        status TEXT NOT NULL CHECK (status IN ('connected', 'needs-reconnect')),
        reconnect_reason TEXT,
        access_token TEXT NOT NULL,
        refresh_token TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        client_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chatgpt_login (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        attempt_id TEXT NOT NULL,
        state TEXT NOT NULL,
        verifier TEXT NOT NULL,
        authorize_url TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chatgpt_usage_limit (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        reached_at INTEGER NOT NULL,
        limited_until INTEGER
      );
      CREATE TABLE IF NOT EXISTS chatgpt_host (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        agent_host_id TEXT NOT NULL
      );
    `);
  }

  connection(): StoredConnection | undefined {
    const row = this.sql
      .exec<ConnectionRow>(
        `SELECT status, reconnect_reason, access_token, refresh_token, expires_at, client_id
         FROM chatgpt_connection WHERE id = 1`,
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
      `INSERT OR REPLACE INTO chatgpt_connection
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
          `UPDATE chatgpt_connection
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
      `UPDATE chatgpt_connection SET status = 'needs-reconnect', reconnect_reason = ?, updated_at = ?
       WHERE id = 1 AND access_token = ?`,
      reason,
      now,
      accessToken,
    );
  }

  disconnect(): void {
    this.sql.exec("DELETE FROM chatgpt_connection");
    this.sql.exec("DELETE FROM chatgpt_login");
    this.clearUsageLimit();
  }

  usageLimit(): StoredUsageLimit | undefined {
    const row = this.sql
      .exec<{ readonly reached_at: number; readonly limited_until: number | null }>(
        "SELECT reached_at, limited_until FROM chatgpt_usage_limit WHERE id = 1",
      )
      .toArray()[0];

    return row === undefined
      ? undefined
      : { reachedAt: row.reached_at, limitedUntil: row.limited_until };
  }

  markUsageLimited(accessToken: string, limit: StoredUsageLimit): void {
    this.sql.exec(
      `INSERT OR REPLACE INTO chatgpt_usage_limit (id, reached_at, limited_until)
       SELECT 1, ?, ? FROM chatgpt_connection
       WHERE id = 1 AND status = 'connected' AND access_token = ?`,
      limit.reachedAt,
      limit.limitedUntil,
      accessToken,
    );
  }

  clearUsageLimit(): void {
    this.sql.exec("DELETE FROM chatgpt_usage_limit");
  }

  login(): StoredLogin | undefined {
    const row = this.sql
      .exec<LoginRow>(
        `SELECT attempt_id, state, verifier, authorize_url, expires_at FROM chatgpt_login WHERE id = 1`,
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
      `INSERT OR REPLACE INTO chatgpt_login (id, attempt_id, state, verifier, authorize_url, expires_at)
       VALUES (1, ?, ?, ?, ?, ?)`,
      login.attemptId,
      login.state,
      login.verifier,
      login.authorizeUrl,
      login.expiresAt,
    );
  }

  clearLogin(): void {
    this.sql.exec("DELETE FROM chatgpt_login");
  }

  agentHostId(): string {
    this.sql.exec(
      "INSERT OR IGNORE INTO chatgpt_host (id, agent_host_id) VALUES (1, ?)",
      crypto.randomUUID(),
    );

    return this.sql
      .exec<{ readonly agent_host_id: string }>(
        "SELECT agent_host_id FROM chatgpt_host WHERE id = 1",
      )
      .one().agent_host_id;
  }
}
