import type { GitHubConnectionStatus } from "./github-connection.js";

/**
 * The access token is never stored. It is installed into the workspace's `gh` configuration and
 * dropped, so this table cannot leak one.
 */
type PendingAuthorization = Readonly<{
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresAt: number;
  intervalSeconds: number;
}>;

export type CredentialSource = "device-authorization" | "configured-token";

export type CheckedStatus = Exclude<GitHubConnectionStatus, { state: "awaiting-authorization" }>;

type ReconnectReason = Extract<CheckedStatus, { state: "reconnect-required" }>["reason"];

export type LastCheck = Readonly<{ status: CheckedStatus; checkedAt: number }>;

export type RecordedConnection = Readonly<{
  login: string;
  source: CredentialSource;
  connectedAt: number;
}>;

type PendingRow = {
  readonly device_code: string;
  readonly user_code: string;
  readonly verification_uri: string;
  readonly expires_at: number;
  readonly interval_seconds: number;
};

type ConnectionRow = {
  readonly login: string;
  readonly credential_source: string;
  readonly connected_at: number;
};

type CheckRow = {
  readonly state: CheckedStatus["state"];
  readonly reconnect_reason: string | null;
  readonly login: string | null;
  readonly credential_source: string | null;
  readonly checked_at: number;
};

function credentialSource(value: string | null): CredentialSource {
  return value === "configured-token" ? "configured-token" : "device-authorization";
}

function reconnectReason(value: string | null): ReconnectReason {
  return value === "credential-missing" || value === "credential-rejected"
    ? value
    : "workspace-unavailable";
}

function checkedStatus(row: CheckRow): CheckedStatus {
  switch (row.state) {
    case "connected":
      return {
        state: "connected",
        login: row.login ?? "",
        source: credentialSource(row.credential_source),
      };
    case "reconnect-required":
      return { state: "reconnect-required", reason: reconnectReason(row.reconnect_reason) };
    case "disconnected":
    case "tooling-missing":
      return { state: row.state };
    default: {
      const exhaustive: never = row.state;

      return exhaustive;
    }
  }
}

export class GitHubConnectionStore {
  private readonly storage: DurableObjectStorage;
  private readonly sql: SqlStorage;

  constructor(storage: DurableObjectStorage) {
    this.storage = storage;
    this.sql = storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS github_authorization (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        device_code TEXT NOT NULL,
        user_code TEXT NOT NULL,
        verification_uri TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        interval_seconds INTEGER NOT NULL
      );
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS github_connection (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        login TEXT NOT NULL,
        credential_source TEXT NOT NULL,
        connected_at INTEGER NOT NULL
      );
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS github_connection_check (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        state TEXT NOT NULL
          CHECK (state IN ('connected', 'disconnected', 'tooling-missing', 'reconnect-required')),
        reconnect_reason TEXT,
        login TEXT,
        credential_source TEXT,
        checked_at INTEGER NOT NULL
      );
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS github_connection_revision (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        revision INTEGER NOT NULL CHECK (revision >= 0)
      );
    `);
  }

  startAuthorization(pending: PendingAuthorization): void {
    this.sql.exec(
      `INSERT INTO github_authorization
         (id, device_code, user_code, verification_uri, expires_at, interval_seconds)
       VALUES (1, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         device_code = excluded.device_code,
         user_code = excluded.user_code,
         verification_uri = excluded.verification_uri,
         expires_at = excluded.expires_at,
         interval_seconds = excluded.interval_seconds`,
      pending.deviceCode,
      pending.userCode,
      pending.verificationUri,
      pending.expiresAt,
      pending.intervalSeconds,
    );
  }

  /** Deletes an expired authorization as it is read, so a device code never outlives its window. */
  pendingAuthorization(now: number): PendingAuthorization | undefined {
    const row = this.sql
      .exec<PendingRow>(
        `SELECT device_code, user_code, verification_uri, expires_at, interval_seconds
         FROM github_authorization WHERE id = 1`,
      )
      .toArray()[0];

    if (row === undefined) {
      return undefined;
    }

    if (row.expires_at <= now) {
      this.consumeAuthorization(row.device_code);

      return undefined;
    }

    return {
      deviceCode: row.device_code,
      userCode: row.user_code,
      verificationUri: row.verification_uri,
      expiresAt: row.expires_at,
      intervalSeconds: row.interval_seconds,
    };
  }

  /** A redemption that ends after a newer authorization started leaves the newer one in place. */
  consumeAuthorization(deviceCode: string): boolean {
    const consumed = this.sql
      .exec(
        `DELETE FROM github_authorization WHERE id = 1 AND device_code = ? RETURNING id`,
        deviceCode,
      )
      .toArray();

    return consumed.length > 0;
  }

  recordConnection(connection: RecordedConnection): void {
    this.sql.exec(
      `INSERT INTO github_connection (id, login, credential_source, connected_at)
       VALUES (1, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         login = excluded.login,
         credential_source = excluded.credential_source,
         connected_at = excluded.connected_at`,
      connection.login,
      connection.source,
      connection.connectedAt,
    );
  }

  private clearConnection(): void {
    this.sql.exec(`DELETE FROM github_connection WHERE id = 1`);
  }

  connection(): RecordedConnection | undefined {
    const row = this.sql
      .exec<ConnectionRow>(
        `SELECT login, credential_source, connected_at FROM github_connection WHERE id = 1`,
      )
      .toArray()[0];

    if (row === undefined) {
      return undefined;
    }

    return {
      login: row.login,
      source: credentialSource(row.credential_source),
      connectedAt: row.connected_at,
    };
  }

  revision(): number {
    const row = this.sql
      .exec<{ readonly revision: number }>(
        `SELECT revision FROM github_connection_revision WHERE id = 1`,
      )
      .toArray()[0];

    return row?.revision ?? 0;
  }

  /**
   * Stores nothing when `revision` is stale: a check a workspace reset overtook saw the old
   * workspace.
   */
  recordCheck(
    revision: number,
    check: LastCheck,
    connection: RecordedConnection | undefined,
  ): void {
    this.storage.transactionSync(() => {
      if (this.revision() !== revision) return;

      if (connection === undefined) this.clearConnection();
      else this.recordConnection(connection);

      const { status } = check;
      this.sql.exec(
        `INSERT OR REPLACE INTO github_connection_check
           (id, state, reconnect_reason, login, credential_source, checked_at)
         VALUES (1, ?, ?, ?, ?, ?)`,
        status.state,
        status.state === "reconnect-required" ? status.reason : null,
        status.state === "connected" ? status.login : null,
        status.state === "connected" ? status.source : null,
        check.checkedAt,
      );
    });
  }

  lastCheck(): LastCheck | undefined {
    const row = this.sql
      .exec<CheckRow>(
        `SELECT state, reconnect_reason, login, credential_source, checked_at
         FROM github_connection_check WHERE id = 1`,
      )
      .toArray()[0];

    return row === undefined
      ? undefined
      : { status: checkedStatus(row), checkedAt: row.checked_at };
  }

  /** Advancing the revision stops checks already running from storing their answer. */
  clear(): void {
    this.storage.transactionSync(() => {
      this.clearConnection();
      this.sql.exec(`DELETE FROM github_connection_check WHERE id = 1`);
      this.sql.exec(
        `INSERT INTO github_connection_revision (id, revision) VALUES (1, 1)
         ON CONFLICT (id) DO UPDATE SET revision = revision + 1`,
      );
    });
  }
}
