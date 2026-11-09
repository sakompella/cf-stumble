import type { DeviceRedemption } from "../../github/index.js";
import { logEvent, type LogLevel } from "../../diagnostics.js";
import type { CredentialSource, GitHubConnectionStatus } from "./github-connection-machine.js";

export type { CredentialSource, GitHubConnectionStatus } from "./github-connection-machine.js";

export type GitHubAuthorizationProblem =
  | "not-configured"
  | "provider-unavailable"
  | "no-pending-authorization"
  | "authorization-expired"
  | "authorization-denied";

export type GitHubConnectionRecord = Readonly<{
  github: GitHubConnectionStatus | null;
  checkedAt: number | null;
}>;

export type GitHubAuthorizationOutcome =
  | Readonly<{ ok: true; status: GitHubConnectionStatus; checkedAt: number | null }>
  | Readonly<{ ok: false; problem: GitHubAuthorizationProblem }>;

function outcome(status: GitHubConnectionStatus): string {
  return status.state === "reconnect-required" ? status.reason : status.state;
}

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

export function unredeemedOutcome(
  kind: Exclude<DeviceRedemption["kind"], "authorized">,
): "pending" | GitHubAuthorizationProblem {
  switch (kind) {
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
