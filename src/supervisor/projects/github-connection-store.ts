import type { GitHubConnectionStatus } from "./github-connection.js";

/**
 * What cf-stumble remembers about the workspace's GitHub authorization, which is deliberately not
 * a credential.
 *
 * Four things are stored. A pending device authorization, which holds the device code GitHub
 * issued and the verified owner who started it, so a redemption can be bound to that owner and a
 * replayed or crossed request finds nothing to redeem. The fact of a connection: a login name, how
 * it was obtained, and when. What the last credential check found and when it ran, which is what a
 * status read answers without asking the workspace. And a revision that each workspace reset
 * advances, so a check that started before a reset cannot store its answer after it. The access
 * token itself is never here — it is installed into the workspace's `gh` configuration and dropped
 * (ADR-0039), so this table cannot leak one.
 */
type PendingAuthorization = Readonly<{
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresAt: number;
  intervalSeconds: number;
  identity: string;
  audience: string;
}>;

/** How the workspace got the credential it has. The configured token is a test path, and says so. */
export type CredentialSource = "device-authorization" | "configured-token";

/** What one credential check found. A pending authorization is never asked of the workspace. */
export type CheckedStatus = Exclude<GitHubConnectionStatus, { state: "awaiting-authorization" }>;

type ReconnectReason = Extract<CheckedStatus, { state: "reconnect-required" }>["reason"];

/** The last credential check: what it found and when it ran. */
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
  readonly identity: string;
  readonly audience: string;
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
        interval_seconds INTEGER NOT NULL,
        identity TEXT NOT NULL,
        audience TEXT NOT NULL
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

  /** Start one authorization, replacing any earlier one. A tenant waits at one page at a time. */
  startAuthorization(pending: PendingAuthorization): void {
    this.sql.exec(
      `INSERT INTO github_authorization
         (id, device_code, user_code, verification_uri, expires_at, interval_seconds, identity, audience)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         device_code = excluded.device_code,
         user_code = excluded.user_code,
         verification_uri = excluded.verification_uri,
         expires_at = excluded.expires_at,
         interval_seconds = excluded.interval_seconds,
         identity = excluded.identity,
         audience = excluded.audience`,
      pending.deviceCode,
      pending.userCode,
      pending.verificationUri,
      pending.expiresAt,
      pending.intervalSeconds,
      pending.identity,
      pending.audience,
    );
  }

  /**
   * The authorization still worth redeeming. An expired one is deleted as it is read, so a device
   * code outlives its window nowhere: a late redemption finds nothing rather than a stale secret.
   */
  pendingAuthorization(now: number): PendingAuthorization | undefined {
    const row = this.sql
      .exec<PendingRow>(
        `SELECT device_code, user_code, verification_uri, expires_at, interval_seconds, identity, audience
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
      identity: row.identity,
      audience: row.audience,
    };
  }

  /**
   * Consume the pending authorization if it is still the one for `deviceCode`, and answer whether
   * this call consumed it. A redeemed device code is never redeemable twice, and a redemption that
   * ends after a newer authorization started leaves the newer one in place.
   */
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

  /** The current revision. A check captures it when it starts and presents it to `recordCheck`. */
  revision(): number {
    const row = this.sql
      .exec<{ readonly revision: number }>(
        `SELECT revision FROM github_connection_revision WHERE id = 1`,
      )
      .toArray()[0];

    return row?.revision ?? 0;
  }

  /**
   * Replace the last check and the connection it found, in one transaction, only while `revision`
   * is still current. A check that a workspace reset overtook found the workspace before the
   * reset, so it stores nothing. `connection` is `undefined` when the check found none.
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

  /**
   * Forget the connection and the last check, and advance the revision, in one transaction. Every
   * check still running started at the old revision, so none of them can store its answer.
   */
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
