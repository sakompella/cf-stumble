import {
  ChatGPTAccount,
  transition,
  type AccountEvent,
  type ReconnectReason,
  type UsageLimit,
} from "./account.js";
import { SignIn, signInTransition, type SignInEvent, type SignInStep } from "./sign-in.js";

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

const RENAMED_TABLES = ["connection", "login", "usage_limit", "host"] as const;

function restoreRenamedTables(sql: SqlStorage): void {
  const existing = new Set(
    sql
      .exec<{ readonly name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .toArray()
      .map((row) => row.name),
  );

  for (const table of RENAMED_TABLES) {
    if (existing.has(`codex_login_${table}`) && !existing.has(`chatgpt_${table}`)) {
      sql.exec(`ALTER TABLE codex_login_${table} RENAME TO chatgpt_${table}`);
    }
  }
}

export class ChatGPTCredentialStore {
  private readonly storage: DurableObjectStorage;
  private readonly sql: SqlStorage;
  private exchanging: string | null = null;

  constructor(storage: DurableObjectStorage) {
    this.storage = storage;
    this.sql = storage.sql;
    restoreRenamedTables(this.sql);
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

  account(): ChatGPTAccount {
    const row = this.sql
      .exec<ConnectionRow>(
        `SELECT status, reconnect_reason, access_token, refresh_token, expires_at, client_id
         FROM chatgpt_connection WHERE id = 1`,
      )
      .toArray()[0];

    if (row === undefined) return ChatGPTAccount.cases.disconnected.make({});

    if (row.status !== "connected") {
      return ChatGPTAccount.cases.needsReconnect.make({
        reason: reconnectReason(row.reconnect_reason),
      });
    }

    return ChatGPTAccount.cases.connected.make({
      accessToken: row.access_token,
      refreshToken: row.refresh_token,
      expiresAt: row.expires_at,
      clientId: row.client_id,
      usageLimit: this.usageLimit(),
    });
  }

  update(event: AccountEvent, now: number): ChatGPTAccount {
    return this.storage.transactionSync(() => this.apply(event, now));
  }

  signIn(): SignIn {
    const row = this.sql
      .exec<LoginRow>(
        `SELECT attempt_id, state, verifier, authorize_url, expires_at FROM chatgpt_login WHERE id = 1`,
      )
      .toArray()[0];

    if (row !== undefined) {
      return SignIn.cases.pending.make({
        attemptId: row.attempt_id,
        state: row.state,
        verifier: row.verifier,
        authorizeUrl: row.authorize_url,
        expiresAt: row.expires_at,
      });
    }

    return this.exchanging === null
      ? SignIn.cases.idle.make({})
      : SignIn.cases.exchanging.make({ attemptId: this.exchanging });
  }

  updateSignIn(event: SignInEvent, now: number): SignInStep {
    const step = this.storage.transactionSync(() => {
      const current = this.signIn();
      const next = signInTransition(current, event);

      if (next.signIn !== current) this.writeLogin(next.signIn);

      if (next.account !== null) this.apply(next.account, now);

      return next;
    });

    this.exchanging = SignIn.match(step.signIn, {
      idle: () => null,
      pending: () => null,
      exchanging: ({ attemptId }) => attemptId,
    });

    return step;
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

  private usageLimit(): UsageLimit | null {
    const row = this.sql
      .exec<{ readonly reached_at: number; readonly limited_until: number | null }>(
        "SELECT reached_at, limited_until FROM chatgpt_usage_limit WHERE id = 1",
      )
      .toArray()[0];

    return row === undefined
      ? null
      : { reachedAt: row.reached_at, limitedUntil: row.limited_until };
  }

  private apply(event: AccountEvent, now: number): ChatGPTAccount {
    const current = this.account();
    const next = transition(current, event);

    if (next !== current) this.writeAccount(next, now);

    return next;
  }

  private writeAccount(account: ChatGPTAccount, now: number): void {
    ChatGPTAccount.match(account, {
      disconnected: () => {
        this.sql.exec("DELETE FROM chatgpt_connection");
        this.writeUsageLimit(null);
      },
      connected: (current) => {
        this.writeConnection("connected", null, current, now);
        this.writeUsageLimit(current.usageLimit);
      },
      needsReconnect: ({ reason }) => {
        const tokens = { accessToken: "", refreshToken: "", expiresAt: 0, clientId: "" };

        this.writeConnection("needs-reconnect", reason, tokens, now);
        this.writeUsageLimit(null);
      },
    });
  }

  private writeConnection(
    status: "connected" | "needs-reconnect",
    reason: ReconnectReason | null,
    tokens: Readonly<{
      accessToken: string;
      refreshToken: string;
      expiresAt: number;
      clientId: string;
    }>,
    now: number,
  ): void {
    this.sql.exec(
      `INSERT OR REPLACE INTO chatgpt_connection
         (id, status, reconnect_reason, access_token, refresh_token, expires_at, client_id, updated_at)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?)`,
      status,
      reason,
      tokens.accessToken,
      tokens.refreshToken,
      tokens.expiresAt,
      tokens.clientId,
      now,
    );
  }

  private writeUsageLimit(limit: UsageLimit | null): void {
    if (limit === null) {
      this.sql.exec("DELETE FROM chatgpt_usage_limit");

      return;
    }

    this.sql.exec(
      "INSERT OR REPLACE INTO chatgpt_usage_limit (id, reached_at, limited_until) VALUES (1, ?, ?)",
      limit.reachedAt,
      limit.limitedUntil,
    );
  }

  private writeLogin(signIn: SignIn): void {
    SignIn.match(signIn, {
      idle: () => this.sql.exec("DELETE FROM chatgpt_login"),
      exchanging: () => this.sql.exec("DELETE FROM chatgpt_login"),
      pending: (pending) =>
        this.sql.exec(
          `INSERT OR REPLACE INTO chatgpt_login
             (id, attempt_id, state, verifier, authorize_url, expires_at)
           VALUES (1, ?, ?, ?, ?, ?)`,
          pending.attemptId,
          pending.state,
          pending.verifier,
          pending.authorizeUrl,
          pending.expiresAt,
        ),
    });
  }
}
