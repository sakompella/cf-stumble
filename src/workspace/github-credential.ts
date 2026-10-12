import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import {
  isTimeoutFailure,
  logRedactedCause,
  redactedExcerpt,
  timedEffect,
  requestIdFields,
  type RequestId,
} from "../diagnostics.js";
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
import { WORKSPACE_COMMAND_TIMEOUT_MS } from "../workspace-command-timeout.js";
import { runLoggedCommand } from "./executor.js";
import {
  answerFailures,
  thrownBy,
  workspaceEffects,
  WorkspaceSyncIncomplete,
  type CommandOutput,
  type WorkspaceEffects,
  type WorkspaceFault,
  type WorkspaceOperations,
} from "./operations.js";
import { asUntrusted, field, hasExactKeys } from "../untrusted.js";

/**
 * The Workspace Host's credential surface: install the workspace's GitHub credential, report what
 * it can do, and ask GitHub whether one repository is reachable.
 *
 * It is a surface of its own for the reason provisioning is: each Workspace Host surface parses
 * only its own request and plans its own commands, and a credential install is neither a build
 * step nor a provisioning step. Keeping it separate also keeps the token out of every other
 * path — this is the only place in cf-stumble where a token value exists inside the workspace
 * boundary, and it exists there for one call.
 *
 * No result carries a token. The install answers with a word, the status with a state and at most
 * a login name, and a failure with text this module redacts before returning it.
 */
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

/**
 * Parse the credential surface's whole RPC input. The token has to look like a token and the
 * repository URL has to canonicalize, so nothing that reaches a command is request text the
 * caller invented.
 */
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

/**
 * Hand the token to `gh` on standard input, which is what `--with-token` reads.
 *
 * The token is an argument of this one call and of nothing else. It is not in the command text, so
 * no process list or shell history can hold it. `gh` writes it to its own configuration, which is
 * the credential itself. Only a failed durable sync needs a cleanup, which `runInstall` does.
 */
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

/**
 * Run the install command, and undo it when its durable copy is not confirmed.
 *
 * The command has already written `hosts.yml` in the container when the sync check fails. Left
 * there, the next status read would report `connected` for a credential the install reported as
 * failed, and a container replacement would then lose it. A best-effort logout makes the
 * container match the failure. The original failure still propagates.
 */
function runInstall(
  operations: Readonly<{ lenient: WorkspaceEffects; durable: WorkspaceEffects }>,
  token: string,
): Effect.Effect<CommandOutput, WorkspaceFault> {
  return runLoggedCommand(
    operations.durable,
    "github-credential.install",
    { source: installCredentialSource(), cwd: "/", timeoutMs: WORKSPACE_COMMAND_TIMEOUT_MS },
    { stdin: `${token}\n` },
  ).pipe(
    Effect.catchTag("WorkspaceSyncIncomplete", (incomplete) =>
      runLoggedCommand(operations.lenient, "github-credential.logout", {
        source: logoutCredentialSource(),
        cwd: "/",
        timeoutMs: WORKSPACE_COMMAND_TIMEOUT_MS,
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
  requestId: RequestId | undefined,
): Effect.Effect<GitHubCredentialStatus, WorkspaceFault> {
  return runLoggedCommand(
    operations,
    "github-credential.status",
    { source: credentialStatusSource(), cwd: "/", timeoutMs: WORKSPACE_COMMAND_TIMEOUT_MS },
    { requestId },
  ).pipe(Effect.map((output) => parseCredentialStatus(output.stdout)));
}

/**
 * Time the status read. `outcome` is the credential state; a command that fails is logged as
 * `threw`. The login stays out of the event.
 */
function timedCredentialStatus(
  operations: WorkspaceEffects,
  requestId: RequestId | undefined,
): Effect.Effect<GitHubCredentialResult, WorkspaceFault> {
  return credentialStatus(operations, requestId).pipe(
    timedEffect(
      "github-credential.status",
      { ...requestIdFields(requestId), timeoutMs: WORKSPACE_COMMAND_TIMEOUT_MS },
      (read) =>
        Result.isSuccess(read)
          ? {
              outcome: read.success.state,
              level: read.success.state === "connected" ? "info" : "warn",
              fields: { timeout: false },
            }
          : {
              outcome: "threw",
              level: "error",
              fields: { timeout: isTimeoutFailure(thrownBy(read.failure)) },
            },
    ),
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
  return runLoggedCommand(operations, "github-credential.verify-repository", {
    source: repositoryAccessSource(repositoryUrl),
    cwd: "/",
    timeoutMs: WORKSPACE_COMMAND_TIMEOUT_MS,
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
  /**
   * Operations that fail unless the workspace's durable copy is complete. The install uses them,
   * so a credential that only the container's disk holds is never reported as installed.
   */
  installOperations: WorkspaceOperations;
  request: unknown;
  /** Names the owner request this call serves, for the log only. It changes no behavior. */
  requestId?: RequestId | undefined;
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
      return timedCredentialStatus(workspaceEffects(input.operations), input.requestId);
    case "verify-repository":
      return repositoryAccess(workspaceEffects(input.operations), parsed.repositoryUrl);
    default: {
      const exhaustive: never = parsed;

      return exhaustive;
    }
  }
}

/** The credential surface's effect shell. Every failure leaves as a redacted plain value. */
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
