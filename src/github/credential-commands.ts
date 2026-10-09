import { shellQuote } from "../shell-quote.js";
import { GITHUB_CLI_CONFIG_DIRECTORY, GIT_GLOBAL_CONFIG_PATH } from "../workspace-layout.js";

/**
 * The shell text that installs, inspects, and exercises the workspace's GitHub credential, kept
 * beside the parsing of what those commands print.
 *
 * ADR-0039 puts the credential in the ordinary local `gh` configuration rather than in a
 * cf-stumble store: `gh auth login --with-token` writes `hosts.yml` under `GH_CONFIG_DIR`, and
 * `gh auth setup-git` points Git's credential helper at it in `GIT_CONFIG_GLOBAL`, so `git` and
 * `gh` authenticate the way they would on any development machine and no cf-stumble code sits
 * between them and GitHub.
 *
 * The token never appears in command text, and these commands create no temporary token file.
 * `gh auth login --with-token` reads it from standard input, which the caller hands to the command
 * directly, so it is never an argument a process list, a shell history, or an error message could
 * carry. `gh` itself then stores it in the persistent `hosts.yml`. Everything these commands print is a fixed word plus, at
 * most, a login name or a Git error, and the caller redacts what it forwards regardless.
 */

const GITHUB_HOSTNAME = "github.com";

/**
 * Shell lines that point `gh` and Git's global configuration at the durable workspace paths.
 *
 * Computer persists only `/workspace`, so a credential under `$HOME` is lost with the container.
 * The image sets the same variables, but a command that names them itself does not depend on the
 * image it runs in. Every command that needs the credential starts with these lines.
 */
export function durableGitHubConfigurationSource(): readonly string[] {
  return [
    `export GH_CONFIG_DIR=${shellQuote(GITHUB_CLI_CONFIG_DIRECTORY)}`,
    `export GIT_CONFIG_GLOBAL=${shellQuote(GIT_GLOBAL_CONFIG_PATH)}`,
  ];
}

/**
 * What the workspace's credential is doing, as the status command reports it. `unusable` is the
 * case that matters: `gh` holds a credential and GitHub rejects it, which must never be presented
 * as a connection.
 */
export type GitHubCredentialState = "connected" | "missing" | "unusable" | "tooling-missing";

export type GitHubCredentialStatus = Readonly<{
  state: GitHubCredentialState;
  login: string | undefined;
}>;

const LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u;

/**
 * Install a token as the workspace's `gh` credential and let Git use it.
 *
 * The command reads the token from its own standard input, so the application creates no
 * temporary token file. `gh` writes the credential into `hosts.yml` itself, and `umask` applies to
 * that write. An interrupted install can leave `hosts.yml` behind; the caller's rollback covers
 * only a failed durable sync.
 *
 * A missing `gh` is reported rather than repaired: ADR-0039 expects the pinned image to carry the
 * development tools, and silently installing a package manager's idea of `gh` during an
 * authorization is not a decision this path may take.
 */
export function installCredentialSource(): string {
  return [
    "set -eu",
    ...durableGitHubConfigurationSource(),
    "umask 077",
    "if ! command -v gh >/dev/null 2>&1; then",
    "  printf 'tooling-missing\\n'",
    "  exit 0",
    "fi",
    `gh auth login --hostname ${GITHUB_HOSTNAME} --with-token`,
    `gh auth setup-git --hostname ${GITHUB_HOSTNAME}`,
    "printf 'installed\\n'",
  ].join("\n");
}

/**
 * Remove the credential from the container, best effort.
 *
 * The install runs this when the durable copy of a fresh credential could not be confirmed, so the
 * container does not keep a credential that the install reported as failed. A missing `gh` or an
 * absent credential is not an error here.
 */
export function logoutCredentialSource(): string {
  return [
    "set -u",
    ...durableGitHubConfigurationSource(),
    `gh auth logout --hostname ${GITHUB_HOSTNAME} >/dev/null 2>&1 || true`,
  ].join("\n");
}

/**
 * Report the credential the workspace actually has.
 *
 * `gh auth status` answers from local configuration and from GitHub, and the login is read with a
 * second API call, so a token that has been revoked since it was installed reports `unusable`
 * rather than `connected`. That distinction is the whole point of the command: a connected status
 * that a tool cannot use is worse than no status at all.
 */
export function credentialStatusSource(): string {
  return [
    "set -u",
    ...durableGitHubConfigurationSource(),
    "if ! command -v gh >/dev/null 2>&1; then",
    "  printf 'tooling-missing\\n'",
    "  exit 0",
    "fi",
    `if ! gh auth status --hostname ${GITHUB_HOSTNAME} >/dev/null 2>&1; then`,
    "  printf 'missing\\n'",
    "  exit 0",
    "fi",
    'login="$(gh api user --jq .login 2>/dev/null || true)"',
    'if [ -z "$login" ]; then',
    "  printf 'unusable\\n'",
    "  exit 0",
    "fi",
    "printf 'connected %s\\n' \"$login\"",
  ].join("\n");
}

/**
 * Ask GitHub, through ordinary Git, whether this workspace may read one repository.
 *
 * `git ls-remote` is the check rather than a `gh` API call because it exercises the credential
 * helper `gh auth setup-git` configured, which is the path a clone will take. `GIT_TERMINAL_PROMPT`
 * is off so a missing credential fails immediately instead of waiting for a password nobody can
 * type.
 */
export function repositoryAccessSource(repositoryUrl: string): string {
  return [
    "set -u",
    ...durableGitHubConfigurationSource(),
    "export GIT_TERMINAL_PROMPT=0",
    `url=${shellQuote(repositoryUrl)}`,
    'if error="$(git ls-remote --heads "$url" 2>&1 >/dev/null)"; then',
    "  printf 'granted\\n'",
    "else",
    "  printf 'denied %s\\n' \"$error\"",
    "fi",
  ].join("\n");
}

/** Parse the status command's one line. Anything unrecognized is `unusable`, never `connected`. */
export function parseCredentialStatus(stdout: string): GitHubCredentialStatus {
  const [state, login] = stdout.trim().split(/\s+/u);

  if (state === undefined) {
    return { state: "unusable", login: undefined };
  }

  switch (state) {
    case "connected":
      return login !== undefined && LOGIN_PATTERN.test(login)
        ? { state: "connected", login }
        : { state: "unusable", login: undefined };
    case "missing":
    case "tooling-missing":
      return { state, login: undefined };
    default:
      return { state: "unusable", login: undefined };
  }
}

export type RepositoryAccess =
  | Readonly<{ granted: true }>
  | Readonly<{ granted: false; detail: string }>;

/** Parse the access check. The failure detail is Git's own text, which the caller redacts. */
export function parseRepositoryAccess(stdout: string): RepositoryAccess {
  const output = stdout.trim();

  if (output === "granted") {
    return { granted: true };
  }

  return { granted: false, detail: output.startsWith("denied ") ? output.slice(7) : output };
}
