import type { DeviceRedemption, GitHubCredentialStatus } from "../../github/index.js";
import { logEvent, type LogLevel } from "../../diagnostics.js";
import type {
  CheckedStatus,
  CredentialSource,
  RecordedConnection,
} from "./github-connection-store.js";

export type GitHubConnectionStatus =
  | Readonly<{ state: "disconnected" }>
  | Readonly<{ state: "tooling-missing" }>
  | Readonly<{
      state: "awaiting-authorization";
      verificationUri: string;
      userCode: string;
      expiresAt: number;
    }>
  | Readonly<{ state: "connected"; login: string; source: CredentialSource }>
  | Readonly<{
      state: "reconnect-required";
      reason: "credential-missing" | "credential-rejected" | "workspace-unavailable";
    }>;

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

export function reconnect(
  reason: "credential-missing" | "credential-rejected" | "workspace-unavailable",
): CheckedStatus {
  return { state: "reconnect-required", reason };
}

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

export type Learned = Readonly<{
  status: CheckedStatus;
  connection: RecordedConnection | undefined;
}>;

export function statusOnly(
  status: CheckedStatus,
): (previous: RecordedConnection | undefined) => Learned {
  return (previous) => ({ status, connection: previous });
}

export function learned(
  answer: GitHubCredentialStatus,
  installedBy: CredentialSource | undefined,
  previous: RecordedConnection | undefined,
  now: number,
): Learned {
  switch (answer.state) {
    case "connected": {
      const login = answer.login ?? previous?.login ?? "";
      const source = installedBy ?? previous?.source ?? "device-authorization";
      const connectedAt = installedBy === undefined ? (previous?.connectedAt ?? 0) : now;

      return {
        status: { state: "connected", login, source },
        connection: { login, source, connectedAt },
      };
    }

    case "tooling-missing":
      return { status: { state: "tooling-missing" }, connection: previous };
    case "missing":
      return {
        status:
          previous === undefined ? { state: "disconnected" } : reconnect("credential-missing"),
        connection: undefined,
      };
    case "unusable":
      return { status: reconnect("credential-rejected"), connection: undefined };
    default: {
      const exhaustive: never = answer.state;

      return exhaustive;
    }
  }
}
