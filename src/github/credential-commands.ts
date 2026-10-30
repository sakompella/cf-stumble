import { shellQuote } from "../shell-quote.js";
import { GITHUB_CLI_CONFIG_DIRECTORY, GIT_GLOBAL_CONFIG_PATH } from "../workspace-layout.js";

/**
 * The token never appears in command text or a temporary file. `gh auth login --with-token` reads it
 * from standard input, so no process list, shell history, or error message can carry it. Output is
 * a fixed word plus at most a login name or a Git error.
 */

const GITHUB_HOSTNAME = "github.com";

/** Computer persists only `/workspace`, so a credential under `$HOME` is lost with the container. */
export function durableGitHubConfigurationSource(): readonly string[] {
  return [
    `export GH_CONFIG_DIR=${shellQuote(GITHUB_CLI_CONFIG_DIRECTORY)}`,
    `export GIT_CONFIG_GLOBAL=${shellQuote(GIT_GLOBAL_CONFIG_PATH)}`,
  ];
}

/** `unusable` means `gh` holds a credential GitHub rejects; it must never be presented as a connection. */
export type GitHubCredentialState = "connected" | "missing" | "unusable" | "tooling-missing";

export type GitHubCredentialStatus = Readonly<{
  state: GitHubCredentialState;
  login: string | undefined;
}>;

const LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u;

/**
 * An interrupted install can leave `hosts.yml` behind; the caller's rollback covers only a failed
 * durable sync. A missing `gh` is reported rather than repaired.
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

/** Best effort. Run when the durable copy of a fresh credential could not be confirmed. */
export function logoutCredentialSource(): string {
  return [
    "set -u",
    ...durableGitHubConfigurationSource(),
    `gh auth logout --hostname ${GITHUB_HOSTNAME} >/dev/null 2>&1 || true`,
  ].join("\n");
}

/** `gh auth status` also asks GitHub, so a token revoked since install reports `unusable`. */
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
 * `git ls-remote` rather than a `gh` API call because it exercises the credential helper a clone
 * uses. `GIT_TERMINAL_PROMPT` is off so a missing credential fails at once, and `timeout` is below
 * the command ceiling so a stalled network answers `denied` instead of the Host killing the command.
 */
export function repositoryAccessSource(repositoryUrl: string): string {
  return [
    "set -u",
    ...durableGitHubConfigurationSource(),
    "export GIT_TERMINAL_PROMPT=0",
    `url=${shellQuote(repositoryUrl)}`,
    'if error="$(timeout 30 git ls-remote --heads "$url" 2>&1 >/dev/null)"; then',
    "  printf 'granted\\n'",
    "else",
    "  printf 'denied %s\\n' \"$error\"",
    "fi",
  ].join("\n");
}

/** Anything unrecognized is `unusable`, never `connected`. */
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

/** The failure detail is Git's own text, which the caller redacts. */
export function parseRepositoryAccess(stdout: string): RepositoryAccess {
  const output = stdout.trim();

  if (output === "granted") {
    return { granted: true };
  }

  return { granted: false, detail: output.startsWith("denied ") ? output.slice(7) : output };
}
