/**
 * What the owner's ChatGPT connection tells its callers: the owner API and page see a
 * {@link ChatGPTConnectionView}, and the model route gets a {@link ChatGPTAccess}.
 */

import type { ReconnectReason } from "./credential-store.js";
import type { CallbackProblem } from "./oauth.js";

export type ChatGPTConnectionStatus =
  | Readonly<{ state: "disconnected" }>
  | Readonly<{ state: "connected"; expiresAt: number }>
  | Readonly<{ state: "needs-reconnect"; reason: ReconnectReason }>;

export type ChatGPTLoginView = Readonly<{
  attemptId: string;
  authorizeUrl: string;
  expiresAt: number;
}>;

/** What the owner API and the page see. It never carries a token, a verifier, or a code. */
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
 * The credential the model route may use now. `unavailable` means the token server was busy or
 * unreachable while the stored token could not be used; the stored tokens are unchanged.
 */
export type ChatGPTAccess =
  | Readonly<{ kind: "ready"; accessToken: string }>
  | Readonly<{ kind: "not-connected" }>
  | Readonly<{ kind: "reconnect-required" }>
  | Readonly<{ kind: "unavailable" }>;
