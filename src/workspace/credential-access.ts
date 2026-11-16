import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { logRedactedCause } from "../diagnostics.js";
import type { GitHubCredentialStatus, GitHubToken, RepositoryAccess } from "../github/index.js";
import {
  boundedRpc,
  isRpcTimeout,
  WORKSPACE_SHORT_RPC_TIMEOUT_MS,
} from "../workspace-command-timeout.js";
import type { WorkspaceHostNamespace, WorkspaceHostRpc } from "./host-rpc.js";

export class CredentialWorkspaceUnavailable extends Data.TaggedError(
  "CredentialWorkspaceUnavailable",
)<{ readonly detail: string }> {}

export class CredentialInstallFailed extends Data.TaggedError("CredentialInstallFailed")<{
  readonly detail: string;
}> {}

export type CredentialNamespace = WorkspaceHostNamespace<CredentialMethod>;

type CredentialMethod = "installCredential" | "credentialStatus" | "checkRepositoryAccess";

export interface WorkspaceCredentialInput {
  readonly workspaceName: string;
  readonly namespace: CredentialNamespace;
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

function ask<Answer extends Readonly<{ ok: boolean }>>(
  input: WorkspaceCredentialInput,
  step: string,
  call: (host: WorkspaceHostRpc<CredentialMethod>) => Promise<Answer>,
  knownToken?: string,
): Effect.Effect<Answer, CredentialWorkspaceUnavailable> {
  return boundedRpc(
    () => call(input.namespace.getByName(input.workspaceName)),
    WORKSPACE_SHORT_RPC_TIMEOUT_MS,
  ).pipe(
    Effect.mapError((cause) => {
      logRedactedCause(
        `credential-access.${step}: ${isRpcTimeout(cause) ? "timeout" : "credential-workspace-unavailable"}`,
        cause,
        knownToken,
      );

      return unavailable();
    }),
  );
}

export function installWorkspaceCredential(
  input: InstallWorkspaceCredentialInput,
): Effect.Effect<GitHubCredentialStatus, CredentialWorkspaceUnavailable | CredentialInstallFailed> {
  return ask(input, "install", (host) => host.installCredential(input.token), input.token).pipe(
    Effect.flatMap((result) => {
      if (result.ok) return Effect.succeed(result.status);

      return Effect.fail(
        result.error.code === "credential-command-failed"
          ? new CredentialInstallFailed({ detail: result.error.detail })
          : unavailable(result.error.detail),
      );
    }),
  );
}

export function readWorkspaceCredentialStatus(
  input: WorkspaceCredentialInput,
): Effect.Effect<GitHubCredentialStatus, CredentialWorkspaceUnavailable> {
  return ask(input, "status", (host) => host.credentialStatus()).pipe(
    Effect.flatMap((result) =>
      result.ok ? Effect.succeed(result.status) : Effect.fail(unavailable(result.error.detail)),
    ),
  );
}

export function checkRepositoryAccess(
  input: RepositoryAccessInput,
): Effect.Effect<RepositoryAccess, CredentialWorkspaceUnavailable> {
  return ask(input, "verify-repository", (host) =>
    host.checkRepositoryAccess(input.repositoryUrl),
  ).pipe(
    Effect.flatMap((result) =>
      result.ok ? Effect.succeed(result.access) : Effect.fail(unavailable(result.error.detail)),
    ),
  );
}
