// oxlint-disable max-lines -- The connection workflow owns status, authorization, and credential install together.
import {
  parseGitHubToken,
  requestDeviceAuthorization,
  redeemDeviceAuthorization,
  type DeviceRedemption,
  type GitHubCredentialStatus,
  type GitHubFetch,
  type GitHubToken,
} from "../../github/index.js";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { logEvent, type LogLevel } from "../../diagnostics.js";
import {
  CredentialInstallFailed,
  installWorkspaceCredential,
  readWorkspaceCredentialStatus,
  type CredentialWorkspaceNamespace,
  type WorkspaceCredentialInput,
} from "../../workspace/index.js";
import type { VerifiedAccessScope } from "../../access/index.js";
import type {
  CheckedStatus,
  CredentialSource,
  GitHubConnectionStore,
} from "./github-connection-store.js";

/**
 * The workspace's GitHub authorization, as the rest of cf-stumble sees it.
 *
 * Every state is safe to show a browser: a verification URL and the short user code the owner types
 * at GitHub, a login name, or a reason to reconnect. No state carries a token, because a token
 * never becomes part of a status — it goes from GitHub's reply into the workspace's `gh`
 * configuration and nowhere else (ADR-0039). `reconnect-required` exists so a connection that
 * stopped working cannot be reported as working.
 */
export type GitHubConnectionStatus =
  | Readonly<{ state: "disconnected" }>
  | Readonly<{ state: "tooling-missing" }>
  | Readonly<{
      state: "awaiting-authorization";
      verificationUri: string;
      userCode: string;
      expiresAt: number;
      intervalSeconds: number;
    }>
  | Readonly<{ state: "connected"; login: string; source: CredentialSource }>
  | Readonly<{
      state: "reconnect-required";
      reason: "credential-missing" | "credential-rejected" | "workspace-unavailable";
    }>;

/**
 * Why an authorization step produced no status. `not-the-initiating-owner` covers both a different
 * verified owner and a replay of a device code this Supervisor has already consumed: in each case
 * there is no pending authorization belonging to this caller.
 */
export type GitHubAuthorizationProblem =
  | "not-configured"
  | "provider-unavailable"
  | "no-pending-authorization"
  | "not-the-initiating-owner"
  | "authorization-expired"
  | "authorization-denied";

/**
 * The connection as this Supervisor last saw it, read without asking the workspace. `checkedAt` is
 * when the workspace last answered a credential check, and `github` is what that check found. A
 * pending authorization is this object's own state, so it is current whatever `checkedAt` says.
 * Both are `null` before the first check, and again after a workspace reset.
 */
export type GitHubConnectionRecord = Readonly<{
  github: GitHubConnectionStatus | null;
  checkedAt: number | null;
}>;

export type GitHubAuthorizationOutcome =
  | Readonly<{ ok: true; status: GitHubConnectionStatus; checkedAt: number | null }>
  | Readonly<{ ok: false; problem: GitHubAuthorizationProblem }>;

/**
 * The deployment's GitHub settings. `clientId` is the OAuth app the device flow belongs to and is
 * not a secret. `fallbackToken` is the documented `GH_TOKEN` path: a token from a Worker secret,
 * for automated tests and unsupervised runs where nobody can stand at a verification page. It is
 * recorded as `configured-token`, so a status never presents it as an owner authorization.
 */
export interface GitHubConnectionEnvironment {
  readonly clientId: string | undefined;
  readonly fallbackToken: string | undefined;
  readonly fetcher: GitHubFetch;
}

interface GitHubConnectionInput {
  readonly store: GitHubConnectionStore;
  /** The tenant's one workspace, named server-side. See `workspace-names.ts`. */
  readonly workspaceName: string;
  readonly namespace: CredentialWorkspaceNamespace;
  readonly environment: GitHubConnectionEnvironment;
}

function reconnect(
  reason: "credential-missing" | "credential-rejected" | "workspace-unavailable",
): CheckedStatus {
  return { state: "reconnect-required", reason };
}

/** One owner's authorization: the scope T3a verified, and never a field a request supplied. */
function sameOwner(scope: VerifiedAccessScope, identity: string, audience: string): boolean {
  return scope.identity === identity && scope.audience === audience;
}

/**
 * How the workspace's GitHub credential appears in the operational log. A status becomes one
 * outcome word: its state, or the reason a reconnect is required. Nothing here reads a token, a
 * device code, a user code, or a login, so none of them can reach the log through these helpers.
 */
function outcome(status: GitHubConnectionStatus): string {
  return status.state === "reconnect-required" ? status.reason : status.state;
}

/** A credential GitHub refused is the fault that went unnoticed for days, so it is an error. */
function level(status: GitHubConnectionStatus): LogLevel {
  if (status.state === "connected" || status.state === "awaiting-authorization") return "info";

  return status.state === "reconnect-required" && status.reason === "credential-rejected"
    ? "error"
    : "warn";
}

function logCredentialInstall(source: CredentialSource, status: GitHubConnectionStatus): void {
  logEvent(level(status), "github-credential.install", { source, outcome: outcome(status) });
}

/** One unattended repair: what the credential was, whether a fallback exists, and what it became. */
function logCredentialEnsure(
  before: GitHubConnectionStatus,
  fallbackConfigured: boolean,
  after: GitHubConnectionStatus,
): void {
  logEvent(level(after), "github-credential.ensure", {
    before: outcome(before),
    fallbackConfigured,
    outcome: outcome(after),
  });
}

/** One step of the device authorization, as the kind of answer it reached. */
function logAuthorization(
  step: "start" | "complete",
  result: GitHubAuthorizationProblem | "started" | "authorized" | "pending" | "superseded",
): void {
  const refused =
    result !== "started" &&
    result !== "authorized" &&
    result !== "pending" &&
    result !== "superseded";

  logEvent(refused ? "warn" : "info", `github-authorization.${step}`, { outcome: result });
}

/** A redemption that returned no token. Retrying while GitHub waits is the ordinary `pending`. */
function unredeemedOutcome(
  kind: Exclude<DeviceRedemption["kind"], "authorized">,
): "pending" | GitHubAuthorizationProblem {
  switch (kind) {
    case "pending":
    case "slow-down":
      return "pending";
    case "expired":
      return "authorization-expired";
    case "denied":
      return "authorization-denied";
    case "unavailable":
      return "provider-unavailable";
    default: {
      const exhaustive: never = kind;

      return exhaustive;
    }
  }
}

/** A status read stops at `signal` and logs under `requestId`; neither changes the answer. */
type StatusReadOptions = Pick<WorkspaceCredentialInput, "signal" | "requestId">;

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

  /** Forget the connection and the last check, because a workspace reset removed the credential. */
  resetWorkspace(): void {
    this.store.clearConnection();
    this.store.clearCheck();
  }

  /**
   * What the connection is doing, asked of the workspace and not repaired. A pending authorization
   * outranks the workspace's own answer, because the owner is mid-flow and the credential
   * legitimately is not there yet.
   */
  status(now: number, options: StatusReadOptions = {}): Effect.Effect<GitHubConnectionStatus> {
    return Effect.suspend(() => {
      const pending = this.pendingStatus(now);

      return pending === undefined
        ? this.observed(now, undefined, options)
        : Effect.succeed(pending);
    });
  }

  /** The connection from this object's own storage. It never reaches the workspace. */
  lastKnown(now: number): GitHubConnectionRecord {
    const lastCheck = this.store.lastCheck();

    return {
      github: this.pendingStatus(now) ?? lastCheck?.status ?? null,
      checkedAt: this.checkedAt(),
    };
  }

  /** When the last check was stored, or `null` before the first and after a reset. */
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

  /**
   * Make the workspace usable if it can be made usable without a human.
   *
   * A working credential is left alone. A missing or rejected one is replaced from the configured
   * `GH_TOKEN` when this deployment has one, which is what keeps automated runs from needing
   * somebody at a verification page. With no fallback the answer is a reconnect requirement, never
   * an optimistic `connected`.
   */
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

  /**
   * Start one device authorization and bind it to the owner who asked for it. The device code
   * stays in storage; what comes back is the verification URL and the user code.
   */
  startAuthorization(
    scope: VerifiedAccessScope,
    now: number,
  ): Effect.Effect<GitHubAuthorizationOutcome> {
    return Effect.gen({ self: this }, function* () {
      const clientId = this.environment.clientId;

      if (clientId === undefined || clientId.trim().length === 0) {
        return { ok: false, problem: "not-configured" } as const;
      }

      const started = yield* Effect.result(
        requestDeviceAuthorization(clientId, this.environment.fetcher),
      );

      logAuthorization("start", Result.isSuccess(started) ? "started" : "provider-unavailable");

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
        identity: scope.identity,
        audience: scope.audience,
      });

      return this.answered(yield* this.status(now));
    });
  }

  /**
   * Redeem the pending authorization once, for the owner that started it.
   *
   * A caller whose verified scope is not the initiating one is refused before the device code is
   * used, and a code that has been redeemed, denied, or has expired is deleted, so the same
   * request replayed finds nothing. A successful redemption installs the token into the workspace
   * inside this call; the token is a local value that never reaches storage or a response.
   *
   * GitHub's answer arrives after a network wait, during which a newer authorization can replace
   * the one this call redeemed, or a concurrent completion can consume it. Such an answer is
   * discarded, token included, and the caller gets the current status.
   */
  completeAuthorization(
    scope: VerifiedAccessScope,
    now: number,
  ): Effect.Effect<GitHubAuthorizationOutcome> {
    return Effect.gen({ self: this }, function* () {
      const clientId = this.environment.clientId;
      const pending = this.store.pendingAuthorization(now);

      if (clientId === undefined) {
        return { ok: false, problem: "not-configured" } as const;
      }

      if (pending === undefined) {
        return { ok: false, problem: "no-pending-authorization" } as const;
      }

      if (!sameOwner(scope, pending.identity, pending.audience)) {
        return { ok: false, problem: "not-the-initiating-owner" } as const;
      }

      const redeemed = yield* redeemDeviceAuthorization(
        { clientId, deviceCode: pending.deviceCode },
        this.environment.fetcher,
      );

      const settled =
        redeemed.kind === "authorized" || redeemed.kind === "expired" || redeemed.kind === "denied";

      if (settled && !this.store.consumeAuthorization(pending.deviceCode)) {
        logAuthorization("complete", "superseded");

        return this.answered(yield* this.status(now));
      }

      if (redeemed.kind === "authorized") {
        logAuthorization("complete", "authorized");

        return this.answered(yield* this.install(redeemed.token, "device-authorization", now));
      }

      const unredeemed = unredeemedOutcome(redeemed.kind);
      logAuthorization("complete", unredeemed);

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

        return this.record(refused, now, signal);
      }

      const status: CheckedStatus =
        installed.success === "tooling-missing"
          ? this.record({ state: "tooling-missing" }, now, signal)
          : yield* this.observed(now, source, { signal });

      logCredentialInstall(source, status);

      return status;
    });
  }

  /**
   * Ask the workspace what its credential can do, keep the stored connection honest about the
   * answer, and store the answer as the last check. `installedBy` names the install that just ran,
   * if one did.
   */
  private observed(
    now: number,
    installedBy?: CredentialSource,
    options: StatusReadOptions = {},
  ): Effect.Effect<CheckedStatus> {
    return readWorkspaceCredentialStatus({
      workspaceName: this.workspaceName,
      namespace: this.namespace,
      ...options,
    }).pipe(
      Effect.match({
        onFailure: () => reconnect("workspace-unavailable"),
        onSuccess: (status) => this.recorded(status, installedBy, now),
      }),
      Effect.map((status) => this.record(status, now, options.signal)),
    );
  }

  /** Store what a check or install just learned. A stopped one learned nothing, so it is skipped. */
  private record(status: CheckedStatus, now: number, signal?: AbortSignal): CheckedStatus {
    if (signal?.aborted !== true) this.store.recordCheck(status, now);

    return status;
  }

  private recorded(
    status: GitHubCredentialStatus,
    installedBy: CredentialSource | undefined,
    now: number,
  ): CheckedStatus {
    const previous = this.store.connection();

    switch (status.state) {
      case "connected": {
        const login = status.login ?? previous?.login ?? "";
        const credentialSource = installedBy ?? previous?.source ?? "device-authorization";
        this.store.recordConnection({
          login,
          source: credentialSource,
          connectedAt: installedBy === undefined ? (previous?.connectedAt ?? 0) : now,
        });

        return { state: "connected", login, source: credentialSource };
      }

      case "tooling-missing":
        return { state: "tooling-missing" };
      case "missing":
        this.store.clearConnection();

        return previous === undefined ? { state: "disconnected" } : reconnect("credential-missing");
      case "unusable":
        this.store.clearConnection();

        return reconnect("credential-rejected");
      default: {
        const exhaustive: never = status.state;

        return exhaustive;
      }
    }
  }
}
