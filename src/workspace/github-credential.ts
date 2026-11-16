import * as Effect from "effect/Effect";
import { isTimeoutFailure, logRedactedCause, redactedExcerpt } from "../diagnostics.js";
import {
  credentialStatusSource,
  installCredentialSource,
  logoutCredentialSource,
  parseCredentialStatus,
  parseGitHubToken,
  parseRepositoryAccess,
  repositoryAccessSource,
  type GitHubCredentialStatus,
  type RepositoryAccess,
} from "../github/index.js";
import { canonicalRepositoryUrl } from "../project-catalog.js";
import { WORKSPACE_SHORT_COMMAND_TIMEOUT_MS } from "../workspace-command-timeout.js";
import {
  answerFailures,
  WorkspaceSyncIncomplete,
  WorkspaceUnavailable,
  type WorkspaceEffects,
  type WorkspaceFault,
} from "./operations.js";

type Refused<Code extends string> = Readonly<{
  ok: false;
  error: Readonly<{ code: Code; detail: string }>;
}>;

export type CredentialInstallResult =
  | Readonly<{ ok: true; status: GitHubCredentialStatus }>
  | Refused<"invalid-request" | "workspace-unavailable" | "credential-command-failed">;

export type CredentialStatusResult =
  | Readonly<{ ok: true; status: GitHubCredentialStatus }>
  | Refused<"workspace-unavailable">;

export type RepositoryAccessResult =
  | Readonly<{ ok: true; access: RepositoryAccess }>
  | Refused<"invalid-request" | "workspace-unavailable">;

function refused<Code extends string>(code: Code, detail = "", knownToken?: string) {
  return { ok: false, error: { code, detail: redactedExcerpt(detail, knownToken) } } as const;
}

function failureLabel(cause: unknown): string {
  if (isTimeoutFailure(cause)) return "timeout";

  return cause instanceof WorkspaceSyncIncomplete ? "sync-incomplete" : "workspace-unavailable";
}

function observedStatus(stdout: string): Effect.Effect<GitHubCredentialStatus, WorkspaceFault> {
  const status = parseCredentialStatus(stdout);

  return status === undefined
    ? Effect.fail(new WorkspaceUnavailable({ cause: "the credential check reached no verdict" }))
    : Effect.succeed(status);
}

type InstallOperations = Readonly<{ lenient: WorkspaceEffects; durable: WorkspaceEffects }>;

function runInstall(operations: InstallOperations, token: string) {
  return operations.durable
    .runCommand(installCredentialSource(), "/", WORKSPACE_SHORT_COMMAND_TIMEOUT_MS, `${token}\n`)
    .pipe(
      Effect.catchTag("WorkspaceSyncIncomplete", (incomplete) =>
        operations.lenient
          .runCommand(logoutCredentialSource(), "/", WORKSPACE_SHORT_COMMAND_TIMEOUT_MS)
          .pipe(
            Effect.asVoid,
            answerFailures((cause) => {
              logRedactedCause(`github-credential.logout: ${failureLabel(cause)}`, cause, token);
            }),
            Effect.andThen(Effect.fail(incomplete)),
          ),
      ),
    );
}

export function installGitHubCredential(
  operations: InstallOperations,
  rawToken: string,
): Effect.Effect<CredentialInstallResult> {
  const token = parseGitHubToken(rawToken);

  if (token === undefined) return Effect.succeed(refused("invalid-request"));

  return runInstall(operations, token).pipe(
    Effect.flatMap((output) =>
      output.exitCode === 0
        ? observedStatus(output.stdout).pipe(
            Effect.map((status): CredentialInstallResult => ({ ok: true, status })),
          )
        : Effect.succeed<CredentialInstallResult>(
            refused("credential-command-failed", output.stderr, token),
          ),
    ),
    answerFailures((cause): CredentialInstallResult => {
      logRedactedCause(`github-credential.install: ${failureLabel(cause)}`, cause, token);

      return refused("workspace-unavailable");
    }),
  );
}

export function readGitHubCredentialStatus(
  operations: WorkspaceEffects,
): Effect.Effect<CredentialStatusResult> {
  return operations
    .runCommand(credentialStatusSource(), "/", WORKSPACE_SHORT_COMMAND_TIMEOUT_MS)
    .pipe(
      Effect.flatMap((output) => observedStatus(output.stdout)),
      Effect.map((status): CredentialStatusResult => ({ ok: true, status })),
      answerFailures((cause): CredentialStatusResult => {
        logRedactedCause(`github-credential.status: ${failureLabel(cause)}`, cause);

        return refused("workspace-unavailable");
      }),
    );
}

export function checkGitHubRepositoryAccess(
  operations: WorkspaceEffects,
  rawRepositoryUrl: string,
): Effect.Effect<RepositoryAccessResult> {
  const repositoryUrl = canonicalRepositoryUrl(rawRepositoryUrl);

  if (repositoryUrl === undefined) return Effect.succeed(refused("invalid-request"));

  return operations
    .runCommand(repositoryAccessSource(repositoryUrl), "/", WORKSPACE_SHORT_COMMAND_TIMEOUT_MS)
    .pipe(
      Effect.map((output): RepositoryAccessResult => {
        const access = parseRepositoryAccess(output.stdout);

        return {
          ok: true,
          access: access.granted
            ? access
            : { granted: false, detail: redactedExcerpt(access.detail) },
        };
      }),
      answerFailures((cause): RepositoryAccessResult => {
        logRedactedCause(`github-credential.verify-repository: ${failureLabel(cause)}`, cause);

        return refused("workspace-unavailable");
      }),
    );
}
