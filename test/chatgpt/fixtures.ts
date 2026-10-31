import type { ChatGPTAccess, ChatGPTCredential, ProviderFetch } from "../../src/chatgpt/index.js";

export const ACCESS_ONE = "chatgpt-access-FAKE-one-0123456789abcdef";

export const ACCESS_TWO = "chatgpt-access-FAKE-two-0123456789abcdef";

export const REFRESH_ONE = "chatgpt-refresh-FAKE-one-0123456789abcdef";

export const REFRESH_TWO = "chatgpt-refresh-FAKE-two-0123456789abcdef";

export const CLIENT_ID = "oaiapp_FAKEclient";

export const DIRECT_SCOPE =
  "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";

export type RecordedCall = Readonly<{ url: string; init: RequestInit }>;

export function grant(access: string, refresh: string, scope = DIRECT_SCOPE): Response {
  return Response.json({
    access_token: access,
    refresh_token: refresh,
    id_token: "eyJ.fake.id",
    token_type: "Bearer",
    expires_in: 3600,
    scope,
  });
}

export function recordingFetch(reply: (call: RecordedCall) => Promise<Response>) {
  const calls: RecordedCall[] = [];

  const fetcher: ProviderFetch = (url, init) => {
    const call = { url, init };
    calls.push(call);

    return reply(call);
  };

  return { calls, fetcher };
}

export function heldReply() {
  let resolveReply: ((response: Response) => void) | undefined;

  const reply = new Promise<Response>((resolve) => {
    resolveReply = resolve;
  });

  function release(response: Response): void {
    resolveReply?.(response);
  }

  return { reply, release };
}

export async function challengeOf(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));

  return btoa(String.fromCodePoint(...new Uint8Array(digest)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function isText(body: RequestInit["body"]): body is string {
  return typeof body === "string";
}

export function bodyOf(call: RecordedCall | undefined): string {
  const body = call?.init.body;

  return isText(body) ? body : "";
}

export function formOf(call: RecordedCall | undefined): URLSearchParams {
  return new URLSearchParams(bodyOf(call));
}

type Json = string | number | boolean | null | readonly Json[] | { readonly [key: string]: Json };

export function responsesEvent(payload: {
  readonly type: string;
  readonly [key: string]: Json;
}): string {
  return `event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`;
}

export function sseResponse(events: readonly string[], status = 200): Response {
  return new Response(events.join(""), {
    status,
    headers: { "content-type": "text/event-stream" },
  });
}

export const COMPLETED = responsesEvent({
  type: "response.completed",
  response: { usage: { input_tokens: 12, output_tokens: 3 } },
});

export const ready = (accessToken: string): ChatGPTAccess => ({ kind: "ready", accessToken });

export type FakeCredential = ChatGPTCredential & {
  readonly asked: (string | undefined)[];
  readonly refused: string[];
  readonly limited: (readonly [accessToken: string, limitedUntil: number | null])[];
};

export function fakeCredential(answers: readonly ChatGPTAccess[]): FakeCredential {
  const asked: (string | undefined)[] = [];
  const refused: string[] = [];
  const limited: FakeCredential["limited"] = [];

  return {
    asked,
    refused,
    limited,
    access: (rejected) => {
      asked.push(rejected);

      return Promise.resolve(answers[asked.length - 1] ?? { kind: "unavailable" });
    },
    markRefused: (token) => {
      refused.push(token);

      return Promise.resolve();
    },
    markUsageLimited: (token, limitedUntil) => {
      limited.push([token, limitedUntil]);

      return Promise.resolve();
    },
  };
}
