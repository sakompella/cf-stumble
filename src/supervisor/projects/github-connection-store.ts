import * as Schema from "effect/Schema";
import {
  authorizationTransition,
  CredentialSource,
  ReconnectReason,
  credentialTransition,
  GitHubAuthorization,
  GitHubCredential,
  recordedOf,
  AuthorizationEvent,
  type CredentialEvent,
} from "./github-connection-machine.js";

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
  readonly state: string;
  readonly reconnect_reason: string | null;
  readonly login: string | null;
  readonly credential_source: string | null;
  readonly checked_at: number;
};

type AuthorizationChange = Readonly<{ before: GitHubAuthorization; after: GitHubAuthorization }>;

const decodeSource = Schema.decodeUnknownSync(CredentialSource);

const decodeReason = Schema.decodeUnknownSync(ReconnectReason);

const sameAuthorization = Schema.toEquivalence(GitHubAuthorization);

function recordedFromRow(connection: ConnectionRow | undefined) {
  return connection === undefined
    ? null
    : {
        login: connection.login,
        source: decodeSource(connection.credential_source),
        connectedAt: connection.connected_at,
      };
}

function decodeRows(
  check: CheckRow | undefined,
  connection: ConnectionRow | undefined,
): GitHubCredential {
  if (check === undefined) return GitHubCredential.cases.unchecked.make({});

  const checkedAt = check.checked_at;
  const recorded = recordedFromRow(connection);

  switch (check.state) {
    case "connected":
      return GitHubCredential.cases.connected.make({
        checkedAt,
        login: check.login ?? "",
        source: decodeSource(check.credential_source),
        connectedAt: connection?.connected_at ?? checkedAt,
      });
    case "tooling-missing":
      return GitHubCredential.cases.toolingMissing.make({ checkedAt, recorded });
    case "reconnect-required":
      return GitHubCredential.cases.reconnectRequired.make({
        checkedAt,
        reason: decodeReason(check.reconnect_reason),
        recorded,
      });
    default:
      return GitHubCredential.cases.disconnected.make({ checkedAt });
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

  credential(): GitHubCredential {
    const check = this.sql
      .exec<CheckRow>(
        `SELECT state, reconnect_reason, login, credential_source, checked_at
         FROM github_connection_check WHERE id = 1`,
      )
      .toArray()[0];

    const connection = this.sql
      .exec<ConnectionRow>(
        `SELECT login, credential_source, connected_at FROM github_connection WHERE id = 1`,
      )
      .toArray()[0];

    return decodeRows(check, connection);
  }

  authorization(now: number): GitHubAuthorization {
    return this.applyAuthorization(AuthorizationEvent.Elapsed({ now })).after;
  }

  applyCredential(revision: number, event: CredentialEvent): GitHubCredential {
    return this.storage.transactionSync(() => {
      const next = credentialTransition(this.credential(), event);

      if (this.revision() === revision) this.writeCredential(next);

      return next;
    });
  }

  applyAuthorization(event: AuthorizationEvent): AuthorizationChange {
    return this.storage.transactionSync(() => {
      const before = this.readAuthorization();
      const after = authorizationTransition(before, event);

      if (!sameAuthorization(before, after)) this.writeAuthorization(after);

      return { before, after };
    });
  }

  revision(): number {
    const row = this.sql
      .exec<{ readonly revision: number }>(
        `SELECT revision FROM github_connection_revision WHERE id = 1`,
      )
      .toArray()[0];

    return row?.revision ?? 0;
  }

  clear(): void {
    this.storage.transactionSync(() => {
      this.writeCredential(GitHubCredential.cases.unchecked.make({}));
      this.sql.exec(
        `INSERT INTO github_connection_revision (id, revision) VALUES (1, 1)
         ON CONFLICT (id) DO UPDATE SET revision = revision + 1`,
      );
    });
  }

  private readAuthorization(): GitHubAuthorization {
    const row = this.sql
      .exec<PendingRow>(
        `SELECT device_code, user_code, verification_uri, expires_at, interval_seconds
         FROM github_authorization WHERE id = 1`,
      )
      .toArray()[0];

    return row === undefined
      ? GitHubAuthorization.cases.idle.make({})
      : GitHubAuthorization.cases.pending.make({
          deviceCode: row.device_code,
          userCode: row.user_code,
          verificationUri: row.verification_uri,
          expiresAt: row.expires_at,
          intervalSeconds: row.interval_seconds,
        });
  }

  private writeAuthorization(authorization: GitHubAuthorization): void {
    GitHubAuthorization.match(authorization, {
      idle: () => {
        this.sql.exec(`DELETE FROM github_authorization WHERE id = 1`);
      },
      pending: (pending) => {
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
      },
    });
  }

  private writeCredential(credential: GitHubCredential): void {
    const recorded = recordedOf(credential);

    if (recorded === null) {
      this.sql.exec(`DELETE FROM github_connection WHERE id = 1`);
    } else {
      this.sql.exec(
        `INSERT INTO github_connection (id, login, credential_source, connected_at)
         VALUES (1, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           login = excluded.login,
           credential_source = excluded.credential_source,
           connected_at = excluded.connected_at`,
        recorded.login,
        recorded.source,
        recorded.connectedAt,
      );
    }

    GitHubCredential.match(credential, {
      unchecked: () => {
        this.sql.exec(`DELETE FROM github_connection_check WHERE id = 1`);
      },
      disconnected: ({ checkedAt }) => {
        this.writeCheck("disconnected", checkedAt, null, null, null);
      },
      toolingMissing: ({ checkedAt }) => {
        this.writeCheck("tooling-missing", checkedAt, null, null, null);
      },
      connected: ({ checkedAt, login, source }) => {
        this.writeCheck("connected", checkedAt, null, login, source);
      },
      reconnectRequired: ({ checkedAt, reason }) => {
        this.writeCheck("reconnect-required", checkedAt, reason, null, null);
      },
    });
  }

  private writeCheck(
    state: string,
    checkedAt: number,
    reason: string | null,
    login: string | null,
    source: string | null,
  ): void {
    this.sql.exec(
      `INSERT OR REPLACE INTO github_connection_check
         (id, state, reconnect_reason, login, credential_source, checked_at)
       VALUES (1, ?, ?, ?, ?, ?)`,
      state,
      reason,
      login,
      source,
      checkedAt,
    );
  }
}
