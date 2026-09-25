import { logEvent, type LogLevel } from "../../diagnostics.js";
import type { GitHubAuthorizationProblem, GitHubConnectionStatus } from "./github-connection.js";
import type { CredentialSource } from "./github-connection-store.js";

/**
 * How the workspace's GitHub credential appears in the operational log. A status becomes one
 * outcome word: its state, or the reason a reconnect is required. Nothing here reads a token, a
 * device code, a user code, or a login, so none of them can reach the log through this module.
 */
function outcome(status: GitHubConnectionStatus): string {
  return status.state === "reconnect-required" ? status.reason : status.state;
}

/** A credential GitHub refused is the fault that went unnoticed for days, so it is an error. */
function level(status: GitHubConnectionStatus): LogLevel {
  if (status.state === "connected" || status.state === "awaiting-authorization") return "info";

  return status.state === "reconnect-required" && status.reason === "credential-rejected"
    ? "error"
    : "warn";
}

export function logCredentialInstall(
  source: CredentialSource,
  status: GitHubConnectionStatus,
): void {
  logEvent(level(status), "github-credential.install", { source, outcome: outcome(status) });
}

/** One unattended repair: what the credential was, whether a fallback exists, and what it became. */
export function logCredentialEnsure(
  before: GitHubConnectionStatus,
  fallbackConfigured: boolean,
  after: GitHubConnectionStatus,
): void {
  logEvent(level(after), "github-credential.ensure", {
    before: outcome(before),
    fallbackConfigured,
    outcome: outcome(after),
  });
}

/** One step of the device authorization, as the kind of answer it reached. */
export function logAuthorization(
  step: "start" | "complete",
  result: GitHubAuthorizationProblem | "started" | "authorized" | "pending",
): void {
  const refused = result !== "started" && result !== "authorized" && result !== "pending";

  logEvent(refused ? "warn" : "info", `github-authorization.${step}`, { outcome: result });
}

/** A redemption as the log reports it. Retrying while GitHub waits is the ordinary `pending`. */
export function redemptionOutcome(
  kind: "authorized" | "pending" | "slow-down" | "expired" | "denied" | "unavailable",
): "authorized" | "pending" | GitHubAuthorizationProblem {
  switch (kind) {
    case "authorized":
      return "authorized";
    case "pending":
    case "slow-down":
      return "pending";
    case "expired":
      return "authorization-expired";
    case "denied":
      return "authorization-denied";
    case "unavailable":
      return "provider-unavailable";
    default: {
      const exhaustive: never = kind;

      return exhaustive;
    }
  }
}
