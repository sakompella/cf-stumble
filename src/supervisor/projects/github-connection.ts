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
  type WorkspaceCredentialInput,
  type WorkspaceHostNamespace,
} from "../../workspace/index.js";
import {
  AuthorizationEvent,
  awaitingStatus,
  checkedAtOf,
  checkedStatus,
  CredentialEvent,
  ensureCommand,
  GitHubAuthorization,
  isWorking,
  knownStatus,
  type CredentialSource,
  type GitHubConnectionStatus,
  type GitHubCredential,
  EnsureCommand,
} from "./github-connection-machine.js";
import type { GitHubConnectionStore } from "./github-connection-store.js";
import {
  logCredentialEnsure,
  logCredentialInstall,
  unredeemedOutcome,
  type GitHubAuthorizationOutcome,
  type GitHubConnectionRecord,
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
  readonly namespace: WorkspaceHostNamespace<"credential">;
  readonly environment: GitHubConnectionEnvironment;
}

type StatusReadOptions = Pick<WorkspaceCredentialInput, "signal">;

export class GitHubConnection {
  private readonly store: GitHubConnectionStore;
  private readonly workspaceName: string;
  private readonly namespace: WorkspaceHostNamespace<"credential">;
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
      const awaiting = awaitingStatus(this.store.authorization(now));

      return awaiting === null
        ? this.observed(this.store.revision(), now, undefined, options).pipe(
            Effect.map(checkedStatus),
          )
        : Effect.succeed(awaiting);
    });
  }

  lastKnown(now: number): GitHubConnectionRecord {
    const credential = this.store.credential();

    return {
      github: knownStatus(credential, this.store.authorization(now)),
      checkedAt: checkedAtOf(credential),
    };
  }

  checkedAt(): number | null {
    return checkedAtOf(this.store.credential());
  }

  credentialWorking(): boolean {
    return isWorking(this.store.credential());
  }

  ensureCredential(now: number, signal?: AbortSignal): Effect.Effect<GitHubConnectionStatus> {
    return Effect.gen({ self: this }, function* () {
      const credential = yield* this.observed(this.store.revision(), now, undefined, { signal });
      const current = checkedStatus(credential);

      if (signal?.aborted === true) return current;

      const fallback = parseGitHubToken(this.environment.fallbackToken);

      return yield* EnsureCommand.$match(ensureCommand(credential, fallback), {
        Usable: ({ credential: usable }) => Effect.succeed(checkedStatus(usable)),
        Unrepairable: ({ credential: unrepairable }) =>
          Effect.sync(() => {
            const status = checkedStatus(unrepairable);

            logCredentialEnsure(status, false, status);

            return status;
          }),
        InstallConfigured: ({ token }) =>
          this.install(token, "configured-token", now, signal).pipe(
            Effect.tap((repaired) =>
              Effect.sync(() => {
                logCredentialEnsure(current, true, repaired);
              }),
            ),
          ),
      });
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

      this.store.applyAuthorization(
        AuthorizationEvent.Started({
          pending: GitHubAuthorization.cases.pending.make({
            deviceCode: authorization.deviceCode,
            userCode: authorization.userCode,
            verificationUri: authorization.verificationUri,
            expiresAt: now + authorization.expiresInSeconds * 1_000,
            intervalSeconds: authorization.intervalSeconds,
          }),
        }),
      );

      return this.answered(yield* this.status(now));
    });
  }

  completeAuthorization(now: number): Effect.Effect<GitHubAuthorizationOutcome> {
    return Effect.gen({ self: this }, function* () {
      const clientId = this.environment.clientId;
      const authorization = this.store.authorization(now);

      if (clientId === undefined) {
        return { ok: false, problem: "not-configured" } as const;
      }

      if (GitHubAuthorization.guards.idle(authorization)) {
        return { ok: false, problem: "no-pending-authorization" } as const;
      }

      const redeemed = yield* redeemDeviceAuthorization(
        { clientId, deviceCode: authorization.deviceCode },
        this.environment.fetcher,
      );

      const settled =
        redeemed.kind === "authorized" || redeemed.kind === "expired" || redeemed.kind === "denied";

      if (settled && !this.consumed(authorization.deviceCode)) {
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

  private consumed(deviceCode: string): boolean {
    const { before, after } = this.store.applyAuthorization(
      AuthorizationEvent.Settled({ deviceCode }),
    );

    return GitHubAuthorization.guards.pending(before) && GitHubAuthorization.guards.idle(after);
  }

  private answered(status: GitHubConnectionStatus): GitHubAuthorizationOutcome {
    return { ok: true, status, checkedAt: this.checkedAt() };
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

      const credential = Result.isFailure(installed)
        ? this.record(
            revision,
            signal,
            CredentialEvent.InstallRefused({
              reason:
                installed.failure instanceof CredentialInstallFailed
                  ? "credential-rejected"
                  : "workspace-unavailable",
              now,
            }),
          )
        : installed.success === "tooling-missing"
          ? this.record(
              revision,
              signal,
              CredentialEvent.Observed({
                answer: { state: "tooling-missing", login: undefined },
                installedBy: undefined,
                now,
              }),
            )
          : yield* this.observed(revision, now, source, { signal });

      const status = checkedStatus(credential);

      logCredentialInstall(source, status);

      return status;
    });
  }

  private observed(
    revision: number,
    now: number,
    installedBy?: CredentialSource,
    options: StatusReadOptions = {},
  ): Effect.Effect<GitHubCredential> {
    return readWorkspaceCredentialStatus({
      workspaceName: this.workspaceName,
      namespace: this.namespace,
      ...options,
    }).pipe(
      Effect.match({
        onFailure: () =>
          this.record(revision, options.signal, CredentialEvent.WorkspaceUnreachable({ now })),
        onSuccess: (answer) =>
          this.record(
            revision,
            options.signal,
            CredentialEvent.Observed({ answer, installedBy, now }),
          ),
      }),
    );
  }

  private record(
    revision: number,
    signal: AbortSignal | undefined,
    event: CredentialEvent,
  ): GitHubCredential {
    return this.store.applyCredential(revision, event, signal?.aborted !== true);
  }
}
