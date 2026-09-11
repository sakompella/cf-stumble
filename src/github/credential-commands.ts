import { shellQuote } from "../shell-quote.js";

/**
 * The shell text that installs, inspects, and exercises the workspace's GitHub credential, kept
 * beside the parsing of what those commands print.
 *
 * ADR-0039 puts the credential in the ordinary local `gh` configuration rather than in a
 * cf-stumble store: `gh auth login --with-token` writes `~/.config/gh/hosts.yml`, and
 * `gh auth setup-git` points Git's credential helper at it, so `git` and `gh` authenticate the way
 * they would on any development machine and no cf-stumble code sits between them and GitHub.
 *
 * The token never appears in command text. It is written to a private staging file outside every
 * repository, read from that file on standard input, and deleted in the same command, so it is
 * never an argument a process list, a shell history, or an error message could carry. Everything
 * these commands print is a fixed word plus, at most, a login name or a Git error, and the caller
 * redacts what it forwards regardless.
 */

/** Outside the workspace root, so the staged token is never inside a repository or a diff. */
export const GITHUB_TOKEN_STAGING_PATH = "/tmp/cf-stumble-gh-token";

export const GITHUB_HOSTNAME = "github.com";

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
 * The command deletes the staging file on every exit path, so an interrupted install leaves no
 * token behind. A missing `gh` is reported rather than repaired: ADR-0039 expects the pinned image
 * to carry the development tools, and silently installing a package manager's idea of `gh` during
 * an authorization is not a decision this path may take.
 */
export function installCredentialSource(stagingPath: string = GITHUB_TOKEN_STAGING_PATH): string {
  return [
    "set -eu",
    "umask 077",
    `token_file=${shellQuote(stagingPath)}`,
    "trap 'rm -f \"$token_file\"' EXIT",
    "if ! command -v gh >/dev/null 2>&1; then",
    "  printf 'tooling-missing\\n'",
    "  exit 0",
    "fi",
    `gh auth login --hostname ${GITHUB_HOSTNAME} --with-token < "$token_file"`,
    `gh auth setup-git --hostname ${GITHUB_HOSTNAME}`,
    "printf 'installed\\n'",
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
