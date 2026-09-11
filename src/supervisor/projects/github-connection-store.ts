/// <reference types="@cloudflare/workers-types" />

/**
 * What cf-stumble remembers about the workspace's GitHub authorization, which is deliberately not
 * a credential.
 *
 * Two things are stored. A pending device authorization, which holds the device code GitHub issued
 * and the verified owner who started it, so a redemption can be bound to that owner and a replayed
 * or crossed request finds nothing to redeem. And the fact of a connection: a login name, how it
 * was obtained, and when. The access token itself is never here — it is installed into the
 * workspace's `gh` configuration and dropped (ADR-0039), so this table cannot leak one.
 */
export type PendingAuthorization = Readonly<{
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

export class GitHubConnectionStore {
  private readonly sql: SqlStorage;

  constructor(storage: DurableObjectStorage) {
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
      this.clearAuthorization();

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

  /** Consume the pending authorization. A redeemed device code is never redeemable twice. */
  clearAuthorization(): void {
    this.sql.exec(`DELETE FROM github_authorization WHERE id = 1`);
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

  clearConnection(): void {
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

    const source: CredentialSource =
      row.credential_source === "configured-token" ? "configured-token" : "device-authorization";

    return { login: row.login, source, connectedAt: row.connected_at };
  }
}
