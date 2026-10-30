import type { ReconnectReason, StoredUsageLimit } from "./credential-store.js";
import type { CallbackProblem } from "./oauth.js";

export type ChatGPTUsageLimit = StoredUsageLimit;

export type ChatGPTConnectionStatus =
  | Readonly<{ state: "disconnected" }>
  | Readonly<{ state: "connected"; expiresAt: number; usageLimit?: ChatGPTUsageLimit }>
  | Readonly<{ state: "needs-reconnect"; reason: ReconnectReason }>;

export type ChatGPTLoginView = Readonly<{
  attemptId: string;
  authorizeUrl: string;
  expiresAt: number;
}>;

/** It never carries a token, a verifier, or a code. */
export type ChatGPTConnectionView = Readonly<{
  connection: ChatGPTConnectionStatus;
  login: ChatGPTLoginView | null;
  model: string;
}>;

export type ChatGPTLoginFailure =
  | "no-sign-in"
  | "expired"
  | CallbackProblem
  | "exchange-refused"
  | "exchange-unavailable"
  | "missing-scope";

export type ChatGPTLoginOutcome =
  | Readonly<{ ok: true; chatgpt: ChatGPTConnectionView }>
  | Readonly<{
      ok: false;
      problem: Readonly<{ code: ChatGPTLoginFailure }>;
      chatgpt: ChatGPTConnectionView;
    }>;

/**
 * `unavailable` means the token server was busy or unreachable; the stored tokens are unchanged.
 */
export type ChatGPTAccess =
  | Readonly<{ kind: "ready"; accessToken: string }>
  | Readonly<{ kind: "not-connected" }>
  | Readonly<{ kind: "reconnect-required" }>
  | Readonly<{ kind: "usage-limited"; limitedUntil: number }>
  | Readonly<{ kind: "unavailable" }>;
