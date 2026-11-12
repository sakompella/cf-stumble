import { shellQuote } from "../shell-quote.js";
import { GITHUB_CLI_CONFIG_DIRECTORY, GIT_GLOBAL_CONFIG_PATH } from "../workspace-layout.js";

const GITHUB_HOSTNAME = "github.com";

export function durableGitHubConfigurationSource(): readonly string[] {
  return [
    `export GH_CONFIG_DIR=${shellQuote(GITHUB_CLI_CONFIG_DIRECTORY)}`,
    `export GIT_CONFIG_GLOBAL=${shellQuote(GIT_GLOBAL_CONFIG_PATH)}`,
  ];
}

export type GitHubCredentialState = "connected" | "missing" | "unusable" | "tooling-missing";

export type GitHubCredentialStatus = Readonly<{
  state: GitHubCredentialState;
  login: string | undefined;
}>;

const LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u;

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

export function logoutCredentialSource(): string {
  return [
    "set -u",
    ...durableGitHubConfigurationSource(),
    `gh auth logout --hostname ${GITHUB_HOSTNAME} >/dev/null 2>&1 || true`,
  ].join("\n");
}

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

export function parseRepositoryAccess(stdout: string): RepositoryAccess {
  const output = stdout.trim();

  if (output === "granted") {
    return { granted: true };
  }

  return { granted: false, detail: output.startsWith("denied ") ? output.slice(7) : output };
}
