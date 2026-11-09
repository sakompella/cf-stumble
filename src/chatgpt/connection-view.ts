import { blockingLimit, ChatGPTAccount, type ReconnectReason, type UsageLimit } from "./account.js";
import type { CallbackProblem } from "./oauth.js";
import { SignIn } from "./sign-in.js";

export type ChatGPTConnectionStatus =
  | Readonly<{ state: "disconnected" }>
  | Readonly<{ state: "connected"; expiresAt: number; usageLimit?: UsageLimit }>
  | Readonly<{ state: "needs-reconnect"; reason: ReconnectReason }>;

type ChatGPTLoginView = Readonly<{
  attemptId: string;
  authorizeUrl: string;
  expiresAt: number;
}>;

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

export type ChatGPTAccess =
  | Readonly<{ kind: "ready"; accessToken: string }>
  | Readonly<{ kind: "not-connected" }>
  | Readonly<{ kind: "reconnect-required" }>
  | Readonly<{ kind: "usage-limited"; limitedUntil: number }>
  | Readonly<{ kind: "unavailable" }>;

function shownLimit(limit: UsageLimit | null, now: number): UsageLimit | null {
  if (limit === null) return null;

  return limit.limitedUntil === null || blockingLimit(limit, now) !== null ? limit : null;
}

export function wireConnection(account: ChatGPTAccount, now: number): ChatGPTConnectionStatus {
  return ChatGPTAccount.match(account, {
    disconnected: (): ChatGPTConnectionStatus => ({ state: "disconnected" }),
    needsReconnect: ({ reason }): ChatGPTConnectionStatus => ({ state: "needs-reconnect", reason }),
    connected: ({ expiresAt, usageLimit }): ChatGPTConnectionStatus => {
      const shown = shownLimit(usageLimit, now);

      return shown === null
        ? { state: "connected", expiresAt }
        : { state: "connected", expiresAt, usageLimit: shown };
    },
  });
}

export function wireLogin(signIn: SignIn, now: number): ChatGPTLoginView | null {
  return SignIn.match(signIn, {
    idle: () => null,
    exchanging: () => null,
    pending: ({ attemptId, authorizeUrl, expiresAt }) =>
      expiresAt <= now ? null : { attemptId, authorizeUrl, expiresAt },
  });
}
