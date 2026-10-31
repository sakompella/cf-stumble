import {
  parseGitHubToken,
  requestDeviceAuthorization,
  redeemDeviceAuthorization,
  type GitHubFetch,
  type GitHubToken,
} from "../../github/index.js";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import {
  CredentialInstallFailed,
  installWorkspaceCredential,
  readWorkspaceCredentialStatus,
  type CredentialWorkspaceNamespace,
  type WorkspaceCredentialInput,
} from "../../workspace/index.js";
import type {
  CheckedStatus,
  CredentialSource,
  GitHubConnectionStore,
  RecordedConnection,
} from "./github-connection-store.js";
import {
  learned,
  logCredentialEnsure,
  logCredentialInstall,
  reconnect,
  statusOnly,
  unredeemedOutcome,
  type GitHubAuthorizationOutcome,
  type GitHubConnectionRecord,
  type GitHubConnectionStatus,
  type Learned,
} from "./github-connection-status.js";

export type { GitHubConnectionStatus } from "./github-connection-status.js";

export interface GitHubConnectionEnvironment {
  readonly clientId: string | undefined;
  readonly fallbackToken: string | undefined;
  readonly fetcher: GitHubFetch;
}

interface GitHubConnectionInput {
  readonly store: GitHubConnectionStore;
  readonly workspaceName: string;
  readonly namespace: CredentialWorkspaceNamespace;
  readonly environment: GitHubConnectionEnvironment;
}

type StatusReadOptions = Pick<WorkspaceCredentialInput, "signal">;

export class GitHubConnection {
  private readonly store: GitHubConnectionStore;
  private readonly workspaceName: string;
  private readonly namespace: CredentialWorkspaceNamespace;
  private readonly environment: GitHubConnectionEnvironment;

  constructor(input: GitHubConnectionInput) {
    this.store = input.store;
    this.workspaceName = input.workspaceName;
    this.namespace = input.namespace;
    this.environment = input.environment;
  }

  resetWorkspace(): void {
    this.store.clear();
  }

  status(now: number, options: StatusReadOptions = {}): Effect.Effect<GitHubConnectionStatus> {
    return Effect.suspend(() => {
      const pending = this.pendingStatus(now);

      return pending === undefined
        ? this.observed(now, undefined, options)
        : Effect.succeed(pending);
    });
  }

  lastKnown(now: number): GitHubConnectionRecord {
    const lastCheck = this.store.lastCheck();

    return {
      github: this.pendingStatus(now) ?? lastCheck?.status ?? null,
      checkedAt: this.checkedAt(),
    };
  }

  checkedAt(): number | null {
    return this.store.lastCheck()?.checkedAt ?? null;
  }

  private answered(status: GitHubConnectionStatus): GitHubAuthorizationOutcome {
    return { ok: true, status, checkedAt: this.checkedAt() };
  }

  private pendingStatus(now: number): GitHubConnectionStatus | undefined {
    const pending = this.store.pendingAuthorization(now);

    return pending === undefined
      ? undefined
      : {
          state: "awaiting-authorization",
          verificationUri: pending.verificationUri,
          userCode: pending.userCode,
          expiresAt: pending.expiresAt,
          intervalSeconds: pending.intervalSeconds,
        };
  }

  ensureCredential(now: number, signal?: AbortSignal): Effect.Effect<GitHubConnectionStatus> {
    return Effect.gen({ self: this }, function* () {
      const current = yield* this.status(now, { signal });

      if (
        signal?.aborted === true ||
        current.state === "connected" ||
        current.state === "tooling-missing"
      ) {
        return current;
      }

      const token = parseGitHubToken(this.environment.fallbackToken);

      const repaired =
        token === undefined ? current : yield* this.install(token, "configured-token", now, signal);

      logCredentialEnsure(current, token !== undefined, repaired);

      return repaired;
    });
  }

  startAuthorization(now: number): Effect.Effect<GitHubAuthorizationOutcome> {
    return Effect.gen({ self: this }, function* () {
      const clientId = this.environment.clientId;

      if (clientId === undefined || clientId.trim().length === 0) {
        return { ok: false, problem: "not-configured" } as const;
      }

      const started = yield* Effect.result(
        requestDeviceAuthorization(clientId, this.environment.fetcher),
      );

      if (Result.isFailure(started)) {
        return { ok: false, problem: "provider-unavailable" } as const;
      }

      const authorization = started.success;
      this.store.startAuthorization({
        deviceCode: authorization.deviceCode,
        userCode: authorization.userCode,
        verificationUri: authorization.verificationUri,
        expiresAt: now + authorization.expiresInSeconds * 1_000,
        intervalSeconds: authorization.intervalSeconds,
      });

      return this.answered(yield* this.status(now));
    });
  }

  completeAuthorization(now: number): Effect.Effect<GitHubAuthorizationOutcome> {
    return Effect.gen({ self: this }, function* () {
      const clientId = this.environment.clientId;
      const pending = this.store.pendingAuthorization(now);

      if (clientId === undefined) {
        return { ok: false, problem: "not-configured" } as const;
      }

      if (pending === undefined) {
        return { ok: false, problem: "no-pending-authorization" } as const;
      }

      const redeemed = yield* redeemDeviceAuthorization(
        { clientId, deviceCode: pending.deviceCode },
        this.environment.fetcher,
      );

      const settled =
        redeemed.kind === "authorized" || redeemed.kind === "expired" || redeemed.kind === "denied";

      if (settled && !this.store.consumeAuthorization(pending.deviceCode)) {
        return this.answered(yield* this.status(now));
      }

      if (redeemed.kind === "authorized") {
        return this.answered(yield* this.install(redeemed.token, "device-authorization", now));
      }

      const unredeemed = unredeemedOutcome(redeemed.kind);

      if (unredeemed === "pending") {
        return this.answered(yield* this.status(now));
      }

      return { ok: false, problem: unredeemed } as const;
    });
  }

  private install(
    token: GitHubToken,
    source: CredentialSource,
    now: number,
    signal?: AbortSignal,
  ): Effect.Effect<GitHubConnectionStatus> {
    return Effect.gen({ self: this }, function* () {
      const revision = this.store.revision();

      const installed = yield* Effect.result(
        installWorkspaceCredential({
          workspaceName: this.workspaceName,
          namespace: this.namespace,
          token,
          signal,
        }),
      );

      if (Result.isFailure(installed)) {
        const refused = reconnect(
          installed.failure instanceof CredentialInstallFailed
            ? "credential-rejected"
            : "workspace-unavailable",
        );

        logCredentialInstall(source, refused);

        return this.record(revision, now, signal, statusOnly(refused));
      }

      const status: CheckedStatus =
        installed.success === "tooling-missing"
          ? this.record(revision, now, signal, statusOnly({ state: "tooling-missing" }))
          : yield* this.observed(now, source, { signal });

      logCredentialInstall(source, status);

      return status;
    });
  }

  private observed(
    now: number,
    installedBy?: CredentialSource,
    options: StatusReadOptions = {},
  ): Effect.Effect<CheckedStatus> {
    return Effect.suspend(() => {
      const revision = this.store.revision();

      return readWorkspaceCredentialStatus({
        workspaceName: this.workspaceName,
        namespace: this.namespace,
        ...options,
      }).pipe(
        Effect.match({
          onFailure: () =>
            this.record(
              revision,
              now,
              options.signal,
              statusOnly(reconnect("workspace-unavailable")),
            ),
          onSuccess: (answer) =>
            this.record(revision, now, options.signal, (previous) =>
              learned(answer, installedBy, previous, now),
            ),
        }),
      );
    });
  }

  private record(
    revision: number,
    now: number,
    signal: AbortSignal | undefined,
    learn: (previous: RecordedConnection | undefined) => Learned,
  ): CheckedStatus {
    const found = learn(this.store.connection());

    if (signal?.aborted !== true) {
      this.store.recordCheck(revision, { status: found.status, checkedAt: now }, found.connection);
    }

    return found.status;
  }
}
