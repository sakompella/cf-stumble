import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import {
  isTimeoutFailure,
  logRedactedCause,
  requestIdFields,
  type RequestId,
} from "../diagnostics.js";
import type { GitHubCredentialRequest, GitHubCredentialResult } from "./github-credential.js";
import type { GitHubCredentialStatus, GitHubToken, RepositoryAccess } from "../github/index.js";
import { WORKSPACE_RPC_TIMEOUT_MS } from "../workspace-command-timeout.js";
import { workspaceRpc } from "./workspace-rpc.js";

/**
 * The Workspace Host credential surface as its caller uses it, and the three questions the caller
 * asks: install this token, what can the workspace's credential do, and may it read this
 * repository.
 *
 * The caller is the Supervisor, which holds the token for the length of one call and keeps no copy
 * (ADR-0039). Everything that comes back is a state, a login name, or redacted text, so a caller
 * that forwards a result verbatim still forwards no credential.
 */
export type CredentialWorkspaceHost = Readonly<{
  credential(
    request: GitHubCredentialRequest,
    requestId?: RequestId,
  ): Promise<GitHubCredentialResult>;
}>;

/** Just enough of the Workspace Host binding to reach the tenant's workspace by name. */
export type CredentialWorkspaceNamespace = Readonly<{
  getByName(name: string): CredentialWorkspaceHost;
}>;

function signalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/**
 * The workspace could not be asked: the Workspace Host threw, refused, or answered with the wrong
 * shape. From the caller's side these are one fact. `detail` is redacted text or empty.
 */
export class CredentialWorkspaceUnavailable extends Data.TaggedError(
  "CredentialWorkspaceUnavailable",
)<{ readonly detail: string }> {
  get code(): "credential-workspace-unavailable" {
    return "credential-workspace-unavailable";
  }
}

/** `gh` refused the token. `detail` is its redacted standard error. */
export class CredentialInstallFailed extends Data.TaggedError("CredentialInstallFailed")<{
  readonly detail: string;
}> {
  get code(): "credential-install-failed" {
    return "credential-install-failed";
  }
}

/** What an install achieved. A workspace image without `gh` is a state, not a crash. */
type CredentialInstallation = "installed" | "tooling-missing";

export interface WorkspaceCredentialInput {
  /** The tenant's one workspace, named server-side. See `workspace-names.ts`. */
  readonly workspaceName: string;
  readonly namespace: CredentialWorkspaceNamespace;
  /** Stops a turn at the next credential RPC boundary. */
  readonly signal?: AbortSignal | undefined;
  /** The owner request this call serves. It reaches the log only. */
  readonly requestId?: RequestId | undefined;
}

interface InstallWorkspaceCredentialInput extends WorkspaceCredentialInput {
  readonly token: GitHubToken;
}

interface RepositoryAccessInput extends WorkspaceCredentialInput {
  readonly repositoryUrl: string;
}

function unavailable(detail = ""): CredentialWorkspaceUnavailable {
  return new CredentialWorkspaceUnavailable({ detail });
}

function ask(
  input: WorkspaceCredentialInput,
  request: GitHubCredentialRequest,
): Effect.Effect<GitHubCredentialResult, CredentialWorkspaceUnavailable> {
  return Effect.gen(function* () {
    if (signalAborted(input.signal)) return yield* unavailable();

    const answered = yield* workspaceRpc(
      { ...requestIdFields(input.requestId), method: "credential", step: request.step },
      () => input.namespace.getByName(input.workspaceName).credential(request, input.requestId),
      WORKSPACE_RPC_TIMEOUT_MS,
    ).pipe(
      Effect.catchTag("WorkspaceRpcFailed", ({ cause }) => {
        logRedactedCause(
          `credential-access.${request.step}: ${isTimeoutFailure(cause) ? "timeout" : "credential-workspace-unavailable"}`,
          cause,
          request.step === "install" ? request.token : undefined,
        );

        return Effect.fail(unavailable());
      }),
    );

    return signalAborted(input.signal) ? yield* unavailable() : answered;
  });
}

/**
 * Install one token as the workspace's `gh` credential.
 *
 * The token travels as an argument of this one call and is never stored by the caller: after this
 * succeeds, the only copy is inside the workspace's own `gh` configuration, which is where
 * ADR-0039 puts it.
 */
export function installWorkspaceCredential(
  input: InstallWorkspaceCredentialInput,
): Effect.Effect<CredentialInstallation, CredentialWorkspaceUnavailable | CredentialInstallFailed> {
  return ask(input, { kind: "github-credential", step: "install", token: input.token }).pipe(
    Effect.flatMap((result) => {
      if (!result.ok) {
        return Effect.fail(
          result.error.code === "credential-command-failed"
            ? new CredentialInstallFailed({ detail: result.error.detail })
            : unavailable(result.error.detail),
        );
      }

      if (result.result.kind === "credential-installed")
        return Effect.succeed("installed" as const);

      return result.result.kind === "credential-status" && result.result.state === "tooling-missing"
        ? Effect.succeed("tooling-missing" as const)
        : Effect.fail(unavailable());
    }),
  );
}

/** Read what the workspace's credential can actually do right now. */
export function readWorkspaceCredentialStatus(
  input: WorkspaceCredentialInput,
): Effect.Effect<GitHubCredentialStatus, CredentialWorkspaceUnavailable> {
  return ask(input, { kind: "github-credential", step: "status" }).pipe(
    Effect.flatMap((result) => {
      if (!result.ok) return Effect.fail(unavailable(result.error.detail));

      return result.result.kind === "credential-status"
        ? Effect.succeed({ state: result.result.state, login: result.result.login })
        : Effect.fail(unavailable());
    }),
  );
}

/** Ask GitHub, through the workspace's own Git, whether this repository is readable. */
export function checkRepositoryAccess(
  input: RepositoryAccessInput,
): Effect.Effect<RepositoryAccess, CredentialWorkspaceUnavailable> {
  return ask(input, {
    kind: "github-credential",
    step: "verify-repository",
    repositoryUrl: input.repositoryUrl,
  }).pipe(
    Effect.flatMap((result) => {
      if (!result.ok) return Effect.fail(unavailable(result.error.detail));

      if (result.result.kind !== "repository-access") return Effect.fail(unavailable());

      return Effect.succeed<RepositoryAccess>(
        result.result.granted
          ? { granted: true }
          : { granted: false, detail: result.result.detail },
      );
    }),
  );
}
