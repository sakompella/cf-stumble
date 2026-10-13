import type { HarnessScenario } from "./fixtures.mjs";
import type { JsonValue } from "../json.mjs";

/**
 * The ChatGPT connection the stub keeps, and what each of its four routes does to it.
 *
 * The page sends the attempt it was shown and the address the owner pasted, and the Supervisor
 * decides whether they match. A stub that accepted any finish could not tell a page that sends the
 * login's own attempt from one that sends a stale one, so the attempt lives here. The stub reads
 * the pasted address for a `code` parameter and nothing more: the real exchange is the Worker's.
 */

export const CHATGPT_MODEL = "gpt-6.1-sol";

export const CHATGPT_AUTHORIZE_URL = "https://auth.example/oauth/authorize";

/** An address the browser ends on after a sign-in the provider accepted. */
export const CHATGPT_CALLBACK_URL = "http://127.0.0.1:1455/auth/callback?code=abc&state=s";

/** An address the browser ends on when the provider sent no code. */
export const CHATGPT_CALLBACK_WITHOUT_CODE = "http://127.0.0.1:1455/auth/callback?state=s";

type Connection =
  | Readonly<{ state: "disconnected" }>
  | Readonly<{ state: "connected"; expiresAt: number }>
  | Readonly<{ state: "needs-reconnect"; reason: "refresh-refused" }>;

export type ChatGPTLogin = Readonly<{ attemptId: string; authorizeUrl: string; expiresAt: number }>;

export type ChatGPTState = Readonly<{
  connection: Connection;
  login: ChatGPTLogin | undefined;
  attempts: number;
}>;

export type ChatGPTAnswer = Readonly<{ status: number; payload: JsonValue; next: ChatGPTState }>;

const CONNECTED: Connection = { state: "connected", expiresAt: 1_760_003_600_000 };

export function initialChatGPT(scenario: HarnessScenario): ChatGPTState {
  const connection: Connection =
    scenario === "chatgpt-connected"
      ? CONNECTED
      : scenario === "chatgpt-needs-reconnect"
        ? { state: "needs-reconnect", reason: "refresh-refused" }
        : { state: "disconnected" };

  return { connection, login: undefined, attempts: 0 };
}

function view(state: ChatGPTState): JsonValue {
  return {
    connection: { ...state.connection },
    login: state.login === undefined ? null : { ...state.login },
    model: CHATGPT_MODEL,
  };
}

function answer(status: number, state: ChatGPTState, problem?: string): ChatGPTAnswer {
  return {
    status,
    payload:
      problem === undefined
        ? { ok: true, chatgpt: view(state) }
        : { ok: false, problem: { code: problem }, chatgpt: view(state) },
    next: state,
  };
}

export function readConnection(state: ChatGPTState): ChatGPTAnswer {
  return answer(200, state);
}

export function startLogin(state: ChatGPTState): ChatGPTAnswer {
  const attempts = state.attempts + 1;
  const attemptId = `attempt-${attempts}`;

  const login = {
    attemptId,
    authorizeUrl: `${CHATGPT_AUTHORIZE_URL}?attempt=${attemptId}`,
    expiresAt: 1_760_000_600_000,
  };

  return answer(200, { ...state, attempts, login });
}

export function finishLogin(
  state: ChatGPTState,
  attemptId: string,
  callbackUrl: string,
): ChatGPTAnswer {
  if (state.login?.attemptId !== attemptId) {
    return answer(400, state, "no-sign-in");
  }

  if (!new URL(callbackUrl).searchParams.has("code")) {
    return answer(400, state, "missing-code");
  }

  return answer(200, { ...state, connection: CONNECTED, login: undefined });
}

export function disconnect(state: ChatGPTState): ChatGPTAnswer {
  return answer(200, { ...state, connection: { state: "disconnected" }, login: undefined });
}
