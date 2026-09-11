import { Result } from "better-result";
import type { GitHubCredentialRequest, GitHubCredentialResult } from "./github-credential.js";
import type { GitHubCredentialStatus, GitHubToken, RepositoryAccess } from "../github/index.js";

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
  credential(request: GitHubCredentialRequest): Promise<GitHubCredentialResult>;
}>;

/** Just enough of the Workspace Host binding to reach the tenant's workspace by name. */
export type CredentialWorkspaceNamespace = Readonly<{
  getByName(name: string): CredentialWorkspaceHost;
}>;

/**
 * Why a credential operation produced no answer. `credential-workspace-unavailable` covers a
 * Workspace Host that threw, refused, or answered with the wrong shape: from the caller's side
 * these are one fact, that the workspace could not be asked.
 */
export type WorkspaceCredentialProblem = Readonly<{
  code: "credential-workspace-unavailable" | "credential-install-failed";
  detail: string;
}>;

/** What an install achieved. A workspace image without `gh` is a state, not a crash. */
export type CredentialInstallation = "installed" | "tooling-missing";

export interface WorkspaceCredentialInput {
  /** The tenant's one workspace, named server-side. See `workspace-names.ts`. */
  readonly workspaceName: string;
  readonly namespace: CredentialWorkspaceNamespace;
}

export interface InstallWorkspaceCredentialInput extends WorkspaceCredentialInput {
  readonly token: GitHubToken;
}

export interface RepositoryAccessInput extends WorkspaceCredentialInput {
  readonly repositoryUrl: string;
}

async function ask(
  input: WorkspaceCredentialInput,
  request: GitHubCredentialRequest,
): Promise<Result<GitHubCredentialResult, WorkspaceCredentialProblem>> {
  try {
    return Result.ok(await input.namespace.getByName(input.workspaceName).credential(request));
  } catch {
    return Result.err({ code: "credential-workspace-unavailable", detail: "" });
  }
}

function unavailable(detail: string): WorkspaceCredentialProblem {
  return { code: "credential-workspace-unavailable", detail };
}

/**
 * Install one token as the workspace's `gh` credential.
 *
 * The token travels as an argument of this one call and is never stored by the caller: after this
 * resolves, the only copy is inside the workspace's own `gh` configuration, which is where
 * ADR-0039 puts it.
 */
export async function installWorkspaceCredential(
  input: InstallWorkspaceCredentialInput,
): Promise<Result<CredentialInstallation, WorkspaceCredentialProblem>> {
  const answered = await ask(input, {
    kind: "github-credential",
    step: "install",
    token: input.token,
  });

  if (answered.isErr()) {
    return Result.err(answered.error);
  }

  const result = answered.value;

  if (!result.ok) {
    return Result.err(
      result.error.code === "credential-command-failed"
        ? { code: "credential-install-failed", detail: result.error.detail }
        : unavailable(result.error.detail),
    );
  }

  if (result.result.kind === "credential-installed") {
    return Result.ok("installed");
  }

  return result.result.kind === "credential-status" && result.result.state === "tooling-missing"
    ? Result.ok("tooling-missing")
    : Result.err(unavailable(""));
}

/** Read what the workspace's credential can actually do right now. */
export async function readWorkspaceCredentialStatus(
  input: WorkspaceCredentialInput,
): Promise<Result<GitHubCredentialStatus, WorkspaceCredentialProblem>> {
  const answered = await ask(input, { kind: "github-credential", step: "status" });

  if (answered.isErr()) {
    return Result.err(answered.error);
  }

  const result = answered.value;

  if (!result.ok) {
    return Result.err(unavailable(result.error.detail));
  }

  return result.result.kind === "credential-status"
    ? Result.ok({ state: result.result.state, login: result.result.login })
    : Result.err(unavailable(""));
}

/** Ask GitHub, through the workspace's own Git, whether this repository is readable. */
export async function checkRepositoryAccess(
  input: RepositoryAccessInput,
): Promise<Result<RepositoryAccess, WorkspaceCredentialProblem>> {
  const answered = await ask(input, {
    kind: "github-credential",
    step: "verify-repository",
    repositoryUrl: input.repositoryUrl,
  });

  if (answered.isErr()) {
    return Result.err(answered.error);
  }

  const result = answered.value;

  if (!result.ok) {
    return Result.err(unavailable(result.error.detail));
  }

  if (result.result.kind !== "repository-access") {
    return Result.err(unavailable(""));
  }

  return Result.ok(
    result.result.granted ? { granted: true } : { granted: false, detail: result.result.detail },
  );
}
