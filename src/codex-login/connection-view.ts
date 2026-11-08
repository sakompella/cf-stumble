import type { ReconnectReason, StoredUsageLimit } from "./credential-store.js";
import type { CallbackProblem } from "./oauth.js";

export type CodexLoginUsageLimit = StoredUsageLimit;

export type CodexLoginConnectionStatus =
  | Readonly<{ state: "disconnected" }>
  | Readonly<{ state: "connected"; expiresAt: number; usageLimit?: CodexLoginUsageLimit }>
  | Readonly<{ state: "needs-reconnect"; reason: ReconnectReason }>;

type CodexLoginView = Readonly<{
  attemptId: string;
  authorizeUrl: string;
  expiresAt: number;
}>;

export type CodexLoginConnectionView = Readonly<{
  connection: CodexLoginConnectionStatus;
  login: CodexLoginView | null;
  model: string;
}>;

export type CodexLoginFailure =
  | "no-sign-in"
  | "expired"
  | CallbackProblem
  | "exchange-refused"
  | "exchange-unavailable"
  | "missing-scope";

export type CodexLoginOutcome =
  | Readonly<{ ok: true; codexLogin: CodexLoginConnectionView }>
  | Readonly<{
      ok: false;
      problem: Readonly<{ code: CodexLoginFailure }>;
      codexLogin: CodexLoginConnectionView;
    }>;

export type CodexLoginAccess =
  | Readonly<{ kind: "ready"; accessToken: string }>
  | Readonly<{ kind: "not-connected" }>
  | Readonly<{ kind: "reconnect-required" }>
  | Readonly<{ kind: "usage-limited"; limitedUntil: number }>
  | Readonly<{ kind: "unavailable" }>;
