import {
  isTimeoutFailure,
  logRedactedCause,
  timed,
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
  redactCredentials,
  repositoryAccessSource,
  type GitHubCredentialState,
  type GitHubCredentialStatus,
} from "../github/index.js";
import { canonicalRepositoryUrl } from "../project-catalog.js";
import { WORKSPACE_COMMAND_TIMEOUT_MS } from "../workspace-command-timeout.js";
import {
  runLoggedCommand,
  WorkspaceSyncIncomplete,
  type CommandOutput,
  type WorkspaceOperations,
} from "./executor.js";
import { asUntrusted, field, fieldsAreExactly } from "./untrusted.js";

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
    error: { code, detail: redactCredentials(detail, knownToken).slice(0, 400) },
  } as const;
}

/**
 * Parse the credential surface's whole RPC input. The token has to look like a token and the
 * repository URL has to canonicalize, so nothing that reaches a command is request text the
 * caller invented.
 */
export function parseGitHubCredentialRequest(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- This is the credential surface's RPC boundary.
  value: unknown,
): GitHubCredentialRequest | GitHubCredentialResult {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Boundary: the RPC payload is untrusted.
  if (value === null || typeof value !== "object") return invalidRequest();
  const request = asUntrusted(value);

  if (field(request, "kind") !== "github-credential") return invalidRequest();

  switch (field(request, "step")) {
    case "install": {
      if (!fieldsAreExactly(request, ["kind", "step", "token"])) return invalidRequest();
      const token = parseGitHubToken(field(request, "token"));

      return token === undefined
        ? invalidRequest()
        : { kind: "github-credential", step: "install", token };
    }

    case "status":
      return fieldsAreExactly(request, ["kind", "step"])
        ? { kind: "github-credential", step: "status" }
        : invalidRequest();
    case "verify-repository": {
      if (!fieldsAreExactly(request, ["kind", "step", "repositoryUrl"])) return invalidRequest();
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
 * no process list or shell history can hold it, and it is not written anywhere, so no install —
 * failed, interrupted, or successful — can leave it on a filesystem to be found later. There is
 * therefore nothing to clean up after this returns.
 */
async function installCredential(
  operations: Readonly<{ lenient: WorkspaceOperations; durable: WorkspaceOperations }>,
  token: string,
): Promise<GitHubCredentialResult> {
  const output = await runInstall(operations, token);

  if (output.exitCode !== 0) {
    return failed("credential-command-failed", output.stderr, token);
  }

  return output.stdout.trim() === "tooling-missing"
    ? { ok: true, result: { kind: "credential-status", state: "tooling-missing", login: void 0 } }
    : { ok: true, result: { kind: "credential-installed" } };
}

/**
 * Run the install command, and undo it when its durable copy is not confirmed.
 *
 * The command has already written `hosts.yml` in the container when the sync check fails. Left
 * there, the next status read would report `connected` for a credential the install reported as
 * failed, and a container replacement would then lose it. A best-effort logout makes the
 * container match the failure. The original failure still propagates.
 */
async function runInstall(
  operations: Readonly<{ lenient: WorkspaceOperations; durable: WorkspaceOperations }>,
  token: string,
): Promise<CommandOutput> {
  try {
    return await runLoggedCommand(
      operations.durable,
      "github-credential.install",
      { source: installCredentialSource(), cwd: "/", timeoutMs: WORKSPACE_COMMAND_TIMEOUT_MS },
      { stdin: `${token}\n` },
    );
  } catch (cause) {
    if (cause instanceof WorkspaceSyncIncomplete) {
      await runLoggedCommand(operations.lenient, "github-credential.logout", {
        source: logoutCredentialSource(),
        cwd: "/",
        timeoutMs: WORKSPACE_COMMAND_TIMEOUT_MS,
      }).catch(() => void 0);
    }

    throw cause;
  }
}

async function credentialStatus(
  operations: WorkspaceOperations,
  requestId: RequestId | undefined,
): Promise<GitHubCredentialStatus> {
  const output = await runLoggedCommand(
    operations,
    "github-credential.status",
    { source: credentialStatusSource(), cwd: "/", timeoutMs: WORKSPACE_COMMAND_TIMEOUT_MS },
    { requestId },
  );

  return parseCredentialStatus(output.stdout);
}

/**
 * Time the status read. `outcome` is the credential state; a command that throws is logged by
 * `timed` as `threw`. The login stays out of the event.
 */
async function timedCredentialStatus(
  operations: WorkspaceOperations,
  requestId: RequestId | undefined,
): Promise<GitHubCredentialResult> {
  const status = await timed(
    "github-credential.status",
    { ...requestIdFields(requestId), timeoutMs: WORKSPACE_COMMAND_TIMEOUT_MS },
    () => credentialStatus(operations, requestId),
    ({ state }) => ({
      outcome: state,
      level: state === "connected" ? "info" : "warn",
      fields: { timeout: false },
    }),
  );

  return {
    ok: true,
    result: { kind: "credential-status", state: status.state, login: status.login },
  };
}

async function repositoryAccess(
  operations: WorkspaceOperations,
  repositoryUrl: string,
): Promise<GitHubCredentialResult> {
  const output = await runLoggedCommand(operations, "github-credential.verify-repository", {
    source: repositoryAccessSource(repositoryUrl),
    cwd: "/",
    timeoutMs: WORKSPACE_COMMAND_TIMEOUT_MS,
  });

  const access = parseRepositoryAccess(output.stdout);

  return {
    ok: true,
    result: {
      kind: "repository-access",
      granted: access.granted,
      detail: access.granted ? "" : redactCredentials(access.detail).slice(0, 400),
    },
  };
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- A caught value can be anything.
function failureLabel(cause: unknown): string {
  if (isTimeoutFailure(cause)) return "timeout";

  return cause instanceof WorkspaceSyncIncomplete ? "sync-incomplete" : "workspace-unavailable";
}

/** The credential surface's effect shell. Every failure leaves as a redacted plain value. */
export async function executeGitHubCredentialRequest(
  input: Readonly<{
    operations: WorkspaceOperations;
    /**
     * Operations that fail unless the workspace's durable copy is complete. The install uses them,
     * so a credential that only the container's disk holds is never reported as installed.
     */
    installOperations: WorkspaceOperations;
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- The public credential request is parsed at this boundary.
    request: unknown;
    /** Names the owner request this call serves, for the log only. It changes no behavior. */
    requestId?: RequestId | undefined;
  }>,
): Promise<GitHubCredentialResult> {
  const parsed = parseGitHubCredentialRequest(input.request);

  if ("ok" in parsed) return parsed;

  try {
    switch (parsed.step) {
      case "install":
        return await installCredential(
          { lenient: input.operations, durable: input.installOperations },
          parsed.token,
        );
      case "status":
        return await timedCredentialStatus(input.operations, input.requestId);
      case "verify-repository":
        return await repositoryAccess(input.operations, parsed.repositoryUrl);
      default: {
        const exhaustive: never = parsed;

        return exhaustive;
      }
    }
  } catch (cause) {
    logRedactedCause(
      `github-credential.${parsed.step}: ${failureLabel(cause)}`,
      cause,
      parsed.step === "install" ? parsed.token : undefined,
    );

    return failed("workspace-unavailable", "");
  }
}
