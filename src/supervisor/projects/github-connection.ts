import {
  parseGitHubToken,
  requestDeviceAuthorization,
  redeemDeviceAuthorization,
  type GitHubCredentialStatus,
  type GitHubFetch,
  type GitHubToken,
} from "../../github/index.js";
import {
  installWorkspaceCredential,
  readWorkspaceCredentialStatus,
  type CredentialWorkspaceNamespace,
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

export interface GitHubConnectionInput {
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

  /**
   * What the connection is doing, read and not repaired. A pending authorization outranks the
   * workspace's own answer, because the owner is mid-flow and the credential legitimately is not
   * there yet.
   */
  status(now: number): Promise<GitHubConnectionStatus> {
    const pending = this.store.pendingAuthorization(now);
    return pending === undefined
      ? this.observed()
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
  async ensureCredential(now: number): Promise<GitHubConnectionStatus> {
    const current = await this.status(now);
    if (current.state === "connected" || current.state === "tooling-missing") {
      return current;
    }

    const token = parseGitHubToken(this.environment.fallbackToken);
    if (token === undefined) {
      return current;
    }

    return this.install(token, "configured-token", now);
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

    const started = await requestDeviceAuthorization(clientId, this.environment.fetcher);
    if (!started.ok) {
      return { ok: false, problem: "provider-unavailable" };
    }

    const authorization = started.authorization;
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

    const redeemed = await redeemDeviceAuthorization(
      { clientId, deviceCode: pending.deviceCode },
      this.environment.fetcher,
    );
    switch (redeemed.kind) {
      case "authorized": {
        this.store.clearAuthorization();
        return {
          ok: true,
          status: await this.install(redeemed.token, "device-authorization", now),
        };
      }
      case "pending":
      case "slow-down":
        return { ok: true, status: await this.status(now) };
      case "expired":
        this.store.clearAuthorization();
        return { ok: false, problem: "authorization-expired" };
      case "denied":
        this.store.clearAuthorization();
        return { ok: false, problem: "authorization-denied" };
      case "unavailable":
        return { ok: false, problem: "provider-unavailable" };
      default: {
        const exhaustive: never = redeemed;
        return exhaustive;
      }
    }
  }

  /** Install a token, then report what the workspace can do with it rather than assuming. */
  private async install(
    token: GitHubToken,
    source: CredentialSource,
    now: number,
  ): Promise<GitHubConnectionStatus> {
    const installed = await installWorkspaceCredential({
      workspaceName: this.workspaceName,
      namespace: this.namespace,
      token,
    });
    if (installed.isErr()) {
      return reconnect(
        installed.error.code === "credential-install-failed"
          ? "credential-rejected"
          : "workspace-unavailable",
      );
    }
    if (installed.value === "tooling-missing") {
      return { state: "tooling-missing" };
    }

    return this.observed(source, now);
  }

  /** Ask the workspace what its credential can do, and keep the record honest about the answer. */
  private async observed(source?: CredentialSource, at?: number): Promise<GitHubConnectionStatus> {
    const read = await readWorkspaceCredentialStatus({
      workspaceName: this.workspaceName,
      namespace: this.namespace,
    });
    if (read.isErr()) {
      return reconnect("workspace-unavailable");
    }

    return this.recorded(read.value, source, at);
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
