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
import { runPlannedCommand } from "./executor.js";
import {
  answerFailures,
  workspaceEffects,
  WorkspaceSyncIncomplete,
  type CommandOutput,
  type WorkspaceEffects,
  type WorkspaceFault,
  type WorkspaceOperations,
} from "./operations.js";
import { asUntrusted, field, hasExactKeys } from "../untrusted.js";

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
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- This is the credential surface's RPC boundary.
  value: unknown,
): GitHubCredentialRequest | GitHubCredentialResult {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Boundary: the RPC payload is untrusted.
  if (value === null || typeof value !== "object") return invalidRequest();
  const request = asUntrusted(value);

  if (field(request, "kind") !== "github-credential") return invalidRequest();

  switch (field(request, "step")) {
    case "install": {
      if (!hasExactKeys(request, ["kind", "step", "token"])) return invalidRequest();
      const token = parseGitHubToken(field(request, "token"));

      return token === undefined
        ? invalidRequest()
        : { kind: "github-credential", step: "install", token };
    }

    case "status":
      return hasExactKeys(request, ["kind", "step"])
        ? { kind: "github-credential", step: "status" }
        : invalidRequest();
    case "verify-repository": {
      if (!hasExactKeys(request, ["kind", "step", "repositoryUrl"])) return invalidRequest();
      const repositoryUrl = canonicalRepositoryUrl(field(request, "repositoryUrl"));

      return repositoryUrl === undefined
        ? invalidRequest()
        : { kind: "github-credential", step: "verify-repository", repositoryUrl };
    }

    default:
      return invalidRequest();
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
  return runPlannedCommand(
    operations.durable,
    { source: installCredentialSource(), cwd: "/", timeoutMs: WORKSPACE_SHORT_COMMAND_TIMEOUT_MS },
    `${token}\n`,
  ).pipe(
    Effect.catchTag("WorkspaceSyncIncomplete", (incomplete) =>
      runPlannedCommand(operations.lenient, {
        source: logoutCredentialSource(),
        cwd: "/",
        timeoutMs: WORKSPACE_SHORT_COMMAND_TIMEOUT_MS,
      }).pipe(
        Effect.asVoid,
        answerFailures((thrown) => {
          logRedactedCause(`github-credential.logout: ${failureLabel(thrown)}`, thrown, token);
        }),
        Effect.andThen(Effect.fail(incomplete)),
      ),
    ),
  );
}

function credentialStatus(
  operations: WorkspaceEffects,
): Effect.Effect<GitHubCredentialStatus, WorkspaceFault> {
  return runPlannedCommand(operations, {
    source: credentialStatusSource(),
    cwd: "/",
    timeoutMs: WORKSPACE_SHORT_COMMAND_TIMEOUT_MS,
  }).pipe(Effect.map((output) => parseCredentialStatus(output.stdout)));
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
  return runPlannedCommand(operations, {
    source: repositoryAccessSource(repositoryUrl),
    cwd: "/",
    timeoutMs: WORKSPACE_SHORT_COMMAND_TIMEOUT_MS,
  }).pipe(
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

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- A thrown value can be anything.
function failureLabel(thrown: unknown): string {
  if (isTimeoutFailure(thrown)) return "timeout";

  return thrown instanceof WorkspaceSyncIncomplete ? "sync-incomplete" : "workspace-unavailable";
}

type CredentialSurfaceInput = Readonly<{
  operations: WorkspaceOperations;
  installOperations: WorkspaceOperations;
  request: unknown;
}>;

function credentialWork(
  parsed: GitHubCredentialRequest,
  input: CredentialSurfaceInput,
): Effect.Effect<GitHubCredentialResult, WorkspaceFault> {
  switch (parsed.step) {
    case "install":
      return installCredential(
        {
          lenient: workspaceEffects(input.operations),
          durable: workspaceEffects(input.installOperations),
        },
        parsed.token,
      );
    case "status":
      return credentialStatusResult(workspaceEffects(input.operations));
    case "verify-repository":
      return repositoryAccess(workspaceEffects(input.operations), parsed.repositoryUrl);
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
    answerFailures((thrown): GitHubCredentialResult => {
      logRedactedCause(
        `github-credential.${parsed.step}: ${failureLabel(thrown)}`,
        thrown,
        parsed.step === "install" ? parsed.token : undefined,
      );

      return failed("workspace-unavailable", "");
    }),
  );
}
