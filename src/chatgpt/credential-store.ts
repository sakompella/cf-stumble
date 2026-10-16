/**
 * The owner's ChatGPT credential and the sign-in that obtains it, in the Supervisor's SQLite.
 *
 * One Supervisor is one owner, so each table holds at most one row. The tokens are plain columns:
 * Durable Object storage is encrypted at rest, and only the Supervisor and the model route it
 * serves ever read them. No method here logs, and no status built from these rows carries a token,
 * a verifier, or a code.
 */

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

/** A usage limit the provider reported; `limitedUntil` is `null` when it named no end. */
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

  /**
   * A completed sign-in replaces whatever connection there was, whichever account it is, and
   * forgets the old one's usage limit.
   */
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

  /**
   * Store a refreshed pair, in one statement, only while `redeemed` is still the stored refresh
   * token. A rotated refresh token is therefore never half written, and a sign-in or disconnect
   * that happened during the refresh wins. Returns whether the pair was stored.
   */
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

  /** Only while `accessToken` is still the stored one, so a refusal cannot break a newer sign-in. */
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

  /** Replaces any earlier usage limit. */
  markUsageLimited(limit: StoredUsageLimit): void {
    this.sql.exec(
      "INSERT OR REPLACE INTO chatgpt_usage_limit (id, reached_at, limited_until) VALUES (1, ?, ?)",
      limit.reachedAt,
      limit.limitedUntil,
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

  /** Replaces any earlier sign-in attempt. */
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

  /**
   * The stable `ext_agent_host_id` this Supervisor sends with every sign-in. It names the host, not
   * the owner, and is not a secret. It outlives a disconnect.
   */
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
