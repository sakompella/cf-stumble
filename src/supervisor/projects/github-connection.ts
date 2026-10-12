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
import { runAtEntryPoint } from "../../run-entry-point.js";
import {
  CredentialInstallFailed,
  installWorkspaceCredential,
  readWorkspaceCredentialStatus,
  type CredentialWorkspaceNamespace,
  type WorkspaceCredentialInput,
} from "../../workspace/index.js";
import type { VerifiedAccessScope } from "../../access/index.js";
import type { CredentialSource, GitHubConnectionStore } from "./github-connection-store.js";

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

export type GitHubAuthorizationOutcome =
  | Readonly<{ ok: true; status: GitHubConnectionStatus }>
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
): GitHubConnectionStatus {
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
  result: GitHubAuthorizationProblem | "started" | "authorized" | "pending",
): void {
  const refused = result !== "started" && result !== "authorized" && result !== "pending";

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

  /** Clear the cached status because a workspace reset removed its credential. */
  resetWorkspace(): void {
    this.store.clearConnection();
  }

  /**
   * What the connection is doing, read and not repaired. A pending authorization outranks the
   * workspace's own answer, because the owner is mid-flow and the credential legitimately is not
   * there yet.
   */
  status(now: number, options: StatusReadOptions = {}): Promise<GitHubConnectionStatus> {
    const pending = this.store.pendingAuthorization(now);

    return pending === undefined
      ? this.observed(undefined, undefined, options)
      : Promise.resolve({
          state: "awaiting-authorization",
          verificationUri: pending.verificationUri,
          userCode: pending.userCode,
          expiresAt: pending.expiresAt,
          intervalSeconds: pending.intervalSeconds,
        });
  }

  /**
   * Make the workspace usable if it can be made usable without a human.
   *
   * A working credential is left alone. A missing or rejected one is replaced from the configured
   * `GH_TOKEN` when this deployment has one, which is what keeps automated runs from needing
   * somebody at a verification page. With no fallback the answer is a reconnect requirement, never
   * an optimistic `connected`.
   */
  async ensureCredential(now: number, signal?: AbortSignal): Promise<GitHubConnectionStatus> {
    const current = await this.status(now, { signal });

    if (
      signal?.aborted === true ||
      current.state === "connected" ||
      current.state === "tooling-missing"
    ) {
      return current;
    }

    const token = parseGitHubToken(this.environment.fallbackToken);

    const repaired =
      token === undefined ? current : await this.install(token, "configured-token", now, signal);

    logCredentialEnsure(current, token !== undefined, repaired);

    return repaired;
  }

  /**
   * Start one device authorization and bind it to the owner who asked for it. The device code
   * stays in storage; what comes back is the verification URL and the user code.
   */
  async startAuthorization(
    scope: VerifiedAccessScope,
    now: number,
  ): Promise<GitHubAuthorizationOutcome> {
    const clientId = this.environment.clientId;

    if (clientId === undefined || clientId.trim().length === 0) {
      return { ok: false, problem: "not-configured" };
    }

    const started = await runAtEntryPoint(
      Effect.result(requestDeviceAuthorization(clientId, this.environment.fetcher)),
    );

    logAuthorization("start", Result.isSuccess(started) ? "started" : "provider-unavailable");

    if (Result.isFailure(started)) {
      return { ok: false, problem: "provider-unavailable" };
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

    return { ok: true, status: await this.status(now) };
  }

  /**
   * Redeem the pending authorization once, for the owner that started it.
   *
   * A caller whose verified scope is not the initiating one is refused before the device code is
   * used, and a code that has been redeemed, denied, or has expired is deleted, so the same
   * request replayed finds nothing. A successful redemption installs the token into the workspace
   * inside this call; the token is a local value that never reaches storage or a response.
   */
  async completeAuthorization(
    scope: VerifiedAccessScope,
    now: number,
  ): Promise<GitHubAuthorizationOutcome> {
    const clientId = this.environment.clientId;
    const pending = this.store.pendingAuthorization(now);

    if (clientId === undefined) {
      return { ok: false, problem: "not-configured" };
    }

    if (pending === undefined) {
      return { ok: false, problem: "no-pending-authorization" };
    }

    if (!sameOwner(scope, pending.identity, pending.audience)) {
      return { ok: false, problem: "not-the-initiating-owner" };
    }

    const redeemed = await runAtEntryPoint(
      redeemDeviceAuthorization(
        { clientId, deviceCode: pending.deviceCode },
        this.environment.fetcher,
      ),
    );

    if (redeemed.kind === "authorized") {
      logAuthorization("complete", "authorized");
      this.store.clearAuthorization();

      return { ok: true, status: await this.install(redeemed.token, "device-authorization", now) };
    }

    const unredeemed = unredeemedOutcome(redeemed.kind);
    logAuthorization("complete", unredeemed);

    if (unredeemed === "pending") {
      return { ok: true, status: await this.status(now) };
    }

    if (redeemed.kind === "expired" || redeemed.kind === "denied") {
      this.store.clearAuthorization();
    }

    return { ok: false, problem: unredeemed };
  }

  private async install(
    token: GitHubToken,
    source: CredentialSource,
    now: number,
    signal?: AbortSignal,
  ): Promise<GitHubConnectionStatus> {
    const installed = await runAtEntryPoint(
      Effect.result(
        installWorkspaceCredential({
          workspaceName: this.workspaceName,
          namespace: this.namespace,
          token,
          signal,
        }),
      ),
    );

    if (Result.isFailure(installed)) {
      const refused = reconnect(
        installed.failure instanceof CredentialInstallFailed
          ? "credential-rejected"
          : "workspace-unavailable",
      );

      logCredentialInstall(source, refused);

      return refused;
    }

    const status: GitHubConnectionStatus =
      installed.success === "tooling-missing"
        ? { state: "tooling-missing" }
        : await this.observed(source, now, { signal });

    logCredentialInstall(source, status);

    return status;
  }

  /** Ask the workspace what its credential can do, and keep the record honest about the answer. */
  private async observed(
    source?: CredentialSource,
    at?: number,
    options: StatusReadOptions = {},
  ): Promise<GitHubConnectionStatus> {
    const read = await runAtEntryPoint(
      Effect.result(
        readWorkspaceCredentialStatus({
          workspaceName: this.workspaceName,
          namespace: this.namespace,
          ...options,
        }),
      ),
    );

    if (Result.isFailure(read)) {
      return reconnect("workspace-unavailable");
    }

    return this.recorded(read.success, source, at);
  }

  private recorded(
    status: GitHubCredentialStatus,
    source: CredentialSource | undefined,
    at: number | undefined,
  ): GitHubConnectionStatus {
    const previous = this.store.connection();

    switch (status.state) {
      case "connected": {
        const login = status.login ?? previous?.login ?? "";
        const credentialSource = source ?? previous?.source ?? "device-authorization";
        this.store.recordConnection({
          login,
          source: credentialSource,
          connectedAt: at ?? previous?.connectedAt ?? 0,
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
