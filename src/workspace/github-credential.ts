import {
  credentialStatusSource,
  installCredentialSource,
  parseCredentialStatus,
  parseGitHubToken,
  parseRepositoryAccess,
  redactCredentials,
  repositoryAccessSource,
  GITHUB_TOKEN_STAGING_PATH,
  type GitHubCredentialState,
} from "../github/index.js";
import { canonicalRepositoryUrl } from "../project-catalog.js";
import type { WorkspaceOperations } from "./executor.js";
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

function failed(code: "workspace-unavailable" | "credential-command-failed", detail: string) {
  return { ok: false, error: { code, detail: redactCredentials(detail).slice(0, 400) } } as const;
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
 * Stage the token in a private file and let `gh` read it from there.
 *
 * The two operations are one step on purpose: the file exists only between the write and the
 * command that consumes and deletes it, and the command deletes it on every exit path. A failed
 * command still gets a removal attempt here, because the one thing worse than a failed install is
 * a token left on disk after it.
 */
async function installCredential(
  operations: WorkspaceOperations,
  token: string,
): Promise<GitHubCredentialResult> {
  await operations.writeFile(GITHUB_TOKEN_STAGING_PATH, `${token}\n`);
  try {
    const output = await operations.runCommand(installCredentialSource(), "/");
    if (output.exitCode !== 0) {
      return failed("credential-command-failed", output.stderr);
    }
    return output.stdout.trim() === "tooling-missing"
      ? { ok: true, result: { kind: "credential-status", state: "tooling-missing", login: void 0 } }
      : { ok: true, result: { kind: "credential-installed" } };
  } finally {
    await clearStagedToken(operations);
  }
}

/**
 * Overwrite the staged token, whatever the install did. The command deletes the file itself on
 * every exit path; this runs second, for the case where the command never ran at all.
 */
async function clearStagedToken(operations: WorkspaceOperations): Promise<void> {
  try {
    await operations.writeFile(GITHUB_TOKEN_STAGING_PATH, "");
  } catch {
    // Nothing to report: the file is already gone, or the workspace is unavailable and the caller
    // is about to hear that from the operation it asked for.
  }
}

async function credentialStatus(operations: WorkspaceOperations): Promise<GitHubCredentialResult> {
  const output = await operations.runCommand(credentialStatusSource(), "/");
  const status = parseCredentialStatus(output.stdout);
  return {
    ok: true,
    result: { kind: "credential-status", state: status.state, login: status.login },
  };
}

async function repositoryAccess(
  operations: WorkspaceOperations,
  repositoryUrl: string,
): Promise<GitHubCredentialResult> {
  const output = await operations.runCommand(repositoryAccessSource(repositoryUrl), "/");
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

/** The credential surface's effect shell. Every failure leaves as a redacted plain value. */
export async function executeGitHubCredentialRequest(
  input: Readonly<{
    operations: WorkspaceOperations;
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- The public credential request is parsed at this boundary.
    request: unknown;
  }>,
): Promise<GitHubCredentialResult> {
  const parsed = parseGitHubCredentialRequest(input.request);
  if ("ok" in parsed) return parsed;

  try {
    switch (parsed.step) {
      case "install":
        return await installCredential(input.operations, parsed.token);
      case "status":
        return await credentialStatus(input.operations);
      case "verify-repository":
        return await repositoryAccess(input.operations, parsed.repositoryUrl);
      default: {
        const exhaustive: never = parsed;
        return exhaustive;
      }
    }
  } catch {
    return failed("workspace-unavailable", "");
  }
}
