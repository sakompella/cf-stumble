export type ConversationProblemCode =
  | "invalid-project-id"
  | "unknown-project-id"
  | "invalid-message"
  | "no-active-generation"
  | "mount-failed"
  | "generation-failed"
  | "workspace-busy";

type ConnectProblemCode =
  | "invalid-repository-url"
  | "repository-not-accessible"
  | "workspace-unavailable"
  | "tooling-missing"
  | "repository-too-large"
  | "provisioning-failed"
  | "workspace-busy";

type DisconnectProblemCode =
  | "invalid-project-id"
  | "unknown-project-id"
  | "run-active"
  | "workspace-busy";

type GitHubAuthorizationProblemCode =
  | "workspace-unavailable"
  | "not-configured"
  | "provider-unavailable"
  | "no-pending-authorization"
  | "authorization-expired"
  | "authorization-denied";

export type ControlProblemCode =
  | "unknown-generation"
  | "not-ready"
  | "not-previously-active"
  | "facet-compatibility-mismatch"
  | "stale-epoch"
  | "run-active"
  | "drops-active-commit";

export type ResetProblemCode = "run-active" | "workspace-busy" | "workspace-unavailable";

type BackendProblemCode = "workspace-busy";

export type ChatGPTLoginProblemCode =
  | "no-sign-in"
  | "expired"
  | "bad-address"
  | "provider-refused"
  | "wrong-sign-in"
  | "missing-code"
  | "missing-client"
  | "exchange-refused"
  | "exchange-unavailable"
  | "missing-scope";

export type ProblemCode =
  | ConversationProblemCode
  | ConnectProblemCode
  | DisconnectProblemCode
  | GitHubAuthorizationProblemCode
  | ControlProblemCode
  | ResetProblemCode
  | BackendProblemCode
  | ChatGPTLoginProblemCode;

export const PROBLEM_STATUS = {
  "invalid-project-id": 400,
  "invalid-message": 400,
  "invalid-repository-url": 400,
  "unknown-project-id": 404,
  "unknown-generation": 404,
  "repository-not-accessible": 403,
  "authorization-denied": 403,
  "authorization-expired": 410,
  "repository-too-large": 413,
  "workspace-busy": 409,
  "run-active": 409,
  "no-pending-authorization": 409,
  "stale-epoch": 409,
  "not-ready": 409,
  "not-previously-active": 409,
  "facet-compatibility-mismatch": 409,
  "drops-active-commit": 409,
  "provider-unavailable": 502,
  "workspace-unavailable": 503,
  "tooling-missing": 503,
  "provisioning-failed": 503,
  "no-active-generation": 503,
  "mount-failed": 503,
  "generation-failed": 503,
  "not-configured": 503,
  "exchange-unavailable": 503,
  "no-sign-in": 400,
  expired: 400,
  "bad-address": 400,
  "provider-refused": 400,
  "wrong-sign-in": 400,
  "missing-code": 400,
  "missing-client": 400,
  "exchange-refused": 400,
  "missing-scope": 400,
} as const satisfies Readonly<Record<ProblemCode, number>>;

export const ERROR_STATUS = {
  "invalid-submission-request": 400,
  "invalid-activation-request": 400,
  "invalid-rollback-request": 400,
  "invalid-connect-request": 400,
  "invalid-message-request": 400,
  "invalid-events-request": 400,
  "invalid-entries-request": 400,
  "invalid-chatgpt-request": 400,
  "invalid-backend-request": 400,
  "cross-origin-request": 403,
  "not-found": 404,
  "preparation-failed": 500,
  "internal-error": 500,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;
