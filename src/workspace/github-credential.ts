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
  type GitHubCredentialState,
  type GitHubCredentialStatus,
} from "../github/index.js";
import { canonicalRepositoryUrl } from "../project-catalog.js";
import { WORKSPACE_SHORT_COMMAND_TIMEOUT_MS } from "../workspace-command-timeout.js";
import {
  answerFailures,
  WorkspaceSyncIncomplete,
  type CommandOutput,
  type WorkspaceEffects,
  type WorkspaceFault,
} from "./operations.js";

export type GitHubCredentialRequest =
  | Readonly<{ kind: "github-credential"; step: "install"; token: string }>
  | Readonly<{ kind: "github-credential"; step: "status" }>
  | Readonly<{ kind: "github-credential"; step: "verify-repository"; repositoryUrl: string }>;

export type GitHubCredentialResult =
  | Readonly<{ ok: true; result: Readonly<{ kind: "credential-installed" }> }>
  | Readonly<{
      ok: true;
      result: Readonly<{
        kind: "credential-status";
        state: GitHubCredentialState;
        login: string | undefined;
      }>;
    }>
  | Readonly<{
      ok: true;
      result: Readonly<{ kind: "repository-access"; granted: boolean; detail: string }>;
    }>
  | Readonly<{
      ok: false;
      error: Readonly<{
        code: "invalid-request" | "workspace-unavailable" | "credential-command-failed";
        detail: string;
      }>;
    }>;

function invalidRequest(): GitHubCredentialResult {
  return { ok: false, error: { code: "invalid-request", detail: "" } };
}

function failed(
  code: "workspace-unavailable" | "credential-command-failed",
  detail: string,
  knownToken?: string,
) {
  return {
    ok: false,
    error: { code, detail: redactedExcerpt(detail, knownToken) },
  } as const;
}

function parseGitHubCredentialRequest(
  request: GitHubCredentialRequest,
): GitHubCredentialRequest | GitHubCredentialResult {
  switch (request.step) {
    case "install": {
      const token = parseGitHubToken(request.token);

      return token === undefined ? invalidRequest() : { ...request, token };
    }

    case "status":
      return request;
    case "verify-repository": {
      const repositoryUrl = canonicalRepositoryUrl(request.repositoryUrl);

      return repositoryUrl === undefined ? invalidRequest() : { ...request, repositoryUrl };
    }

    default: {
      const exhaustive: never = request;

      return exhaustive;
    }
  }
}

function installCredential(
  operations: Readonly<{ lenient: WorkspaceEffects; durable: WorkspaceEffects }>,
  token: string,
): Effect.Effect<GitHubCredentialResult, WorkspaceFault> {
  return runInstall(operations, token).pipe(
    Effect.map((output): GitHubCredentialResult => {
      if (output.exitCode !== 0) {
        return failed("credential-command-failed", output.stderr, token);
      }

      return output.stdout.trim() === "tooling-missing"
        ? {
            ok: true,
            result: { kind: "credential-status", state: "tooling-missing", login: void 0 },
          }
        : { ok: true, result: { kind: "credential-installed" } };
    }),
  );
}

function runInstall(
  operations: Readonly<{ lenient: WorkspaceEffects; durable: WorkspaceEffects }>,
  token: string,
): Effect.Effect<CommandOutput, WorkspaceFault> {
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

function credentialStatus(
  operations: WorkspaceEffects,
): Effect.Effect<GitHubCredentialStatus, WorkspaceFault> {
  return operations
    .runCommand(credentialStatusSource(), "/", WORKSPACE_SHORT_COMMAND_TIMEOUT_MS)
    .pipe(Effect.map((output) => parseCredentialStatus(output.stdout)));
}

function credentialStatusResult(
  operations: WorkspaceEffects,
): Effect.Effect<GitHubCredentialResult, WorkspaceFault> {
  return credentialStatus(operations).pipe(
    Effect.map((status): GitHubCredentialResult => ({
      ok: true,
      result: { kind: "credential-status", state: status.state, login: status.login },
    })),
  );
}

function repositoryAccess(
  operations: WorkspaceEffects,
  repositoryUrl: string,
): Effect.Effect<GitHubCredentialResult, WorkspaceFault> {
  return operations
    .runCommand(repositoryAccessSource(repositoryUrl), "/", WORKSPACE_SHORT_COMMAND_TIMEOUT_MS)
    .pipe(
      Effect.map((output): GitHubCredentialResult => {
        const access = parseRepositoryAccess(output.stdout);

        return {
          ok: true,
          result: {
            kind: "repository-access",
            granted: access.granted,
            detail: access.granted ? "" : redactedExcerpt(access.detail),
          },
        };
      }),
    );
}

function failureLabel(cause: unknown): string {
  if (isTimeoutFailure(cause)) return "timeout";

  return cause instanceof WorkspaceSyncIncomplete ? "sync-incomplete" : "workspace-unavailable";
}

type CredentialSurfaceInput = Readonly<{
  operations: WorkspaceEffects;
  installOperations: WorkspaceEffects;
  request: GitHubCredentialRequest;
}>;

function credentialWork(
  parsed: GitHubCredentialRequest,
  input: CredentialSurfaceInput,
): Effect.Effect<GitHubCredentialResult, WorkspaceFault> {
  switch (parsed.step) {
    case "install":
      return installCredential(
        { lenient: input.operations, durable: input.installOperations },
        parsed.token,
      );
    case "status":
      return credentialStatusResult(input.operations);
    case "verify-repository":
      return repositoryAccess(input.operations, parsed.repositoryUrl);
    default: {
      const exhaustive: never = parsed;

      return exhaustive;
    }
  }
}

export function executeGitHubCredentialRequest(
  input: CredentialSurfaceInput,
): Effect.Effect<GitHubCredentialResult> {
  const parsed = parseGitHubCredentialRequest(input.request);

  if ("ok" in parsed) return Effect.succeed(parsed);

  return Effect.suspend(() => credentialWork(parsed, input)).pipe(
    answerFailures((cause): GitHubCredentialResult => {
      logRedactedCause(
        `github-credential.${parsed.step}: ${failureLabel(cause)}`,
        cause,
        parsed.step === "install" ? parsed.token : undefined,
      );

      return failed("workspace-unavailable", "");
    }),
  );
}
