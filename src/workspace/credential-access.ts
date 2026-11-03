import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { isTimeoutFailure, logRedactedCause } from "../diagnostics.js";
import type { GitHubCredentialRequest, GitHubCredentialResult } from "./github-credential.js";
import type { GitHubCredentialStatus, GitHubToken, RepositoryAccess } from "../github/index.js";
import { boundedRpc, WORKSPACE_SHORT_RPC_TIMEOUT_MS } from "../workspace-command-timeout.js";

export type CredentialWorkspaceHost = Readonly<{
  credential(request: GitHubCredentialRequest): Promise<GitHubCredentialResult>;
}>;

export type CredentialWorkspaceNamespace = Readonly<{
  getByName(name: string): CredentialWorkspaceHost;
}>;

function signalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

export class CredentialWorkspaceUnavailable extends Data.TaggedError(
  "CredentialWorkspaceUnavailable",
)<{ readonly detail: string }> {
  get code(): "credential-workspace-unavailable" {
    return "credential-workspace-unavailable";
  }
}

export class CredentialInstallFailed extends Data.TaggedError("CredentialInstallFailed")<{
  readonly detail: string;
}> {
  get code(): "credential-install-failed" {
    return "credential-install-failed";
  }
}

type CredentialInstallation = "installed" | "tooling-missing";

export interface WorkspaceCredentialInput {
  readonly workspaceName: string;
  readonly namespace: CredentialWorkspaceNamespace;
  readonly signal?: AbortSignal | undefined;
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

    const answered = yield* Effect.tryPromise({
      try: () =>
        boundedRpc(
          () => input.namespace.getByName(input.workspaceName).credential(request),
          WORKSPACE_SHORT_RPC_TIMEOUT_MS,
        ),
      catch: (cause) => {
        logRedactedCause(
          `credential-access.${request.step}: ${isTimeoutFailure(cause) ? "timeout" : "credential-workspace-unavailable"}`,
          cause,
          request.step === "install" ? request.token : undefined,
        );

        return unavailable();
      },
    });

    return signalAborted(input.signal) ? yield* unavailable() : answered;
  });
}

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
