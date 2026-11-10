import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { defineTaggedUnion } from "foldkit/schema";

const PendingLogin = Schema.Struct({
  attemptId: Schema.String,
  authorizeUrl: Schema.String,
  address: Schema.String,
});

export type PendingLogin = typeof PendingLogin.Type;

const UsageLimit = defineTaggedUnion({
  Clear: {},
  Limited: { maybeUntil: Schema.Option(Schema.Number) },
});

type UsageLimit = typeof UsageLimit.Type;

export const ChatGPT = defineTaggedUnion({
  Unknown: {},
  Disconnected: { maybeLogin: Schema.Option(PendingLogin) },
  NeedsReconnect: { reason: Schema.String, maybeLogin: Schema.Option(PendingLogin) },
  Connected: { model: Schema.String, usageLimit: UsageLimit },
});

export type ChatGPT = typeof ChatGPT.Type;

function usageLimitWording(limit: UsageLimit): string {
  return UsageLimit.match(limit, {
    Clear: () => "",
    Limited: ({ maybeUntil }) =>
      Option.match(maybeUntil, {
        onNone: () => "; usage limit reached",
        onSome: (until) =>
          `; usage limit reached until ${new Date(until).toISOString().slice(0, 16).replace("T", " ")} UTC`,
      }),
  });
}

export function chatGPTWording(chatgpt: ChatGPT): string {
  return ChatGPT.match(chatgpt, {
    Unknown: () => "unknown",
    Disconnected: () => "not connected (Workers AI fallback)",
    NeedsReconnect: ({ reason }) => `reconnect required: ${reason}`,
    Connected: ({ model, usageLimit }) => `connected (${model})${usageLimitWording(usageLimit)}`,
  });
}

export function pendingLogin(chatgpt: ChatGPT): Option.Option<PendingLogin> {
  return ChatGPT.matchOrElse(
    chatgpt,
    {
      Disconnected: ({ maybeLogin }) => maybeLogin,
      NeedsReconnect: ({ maybeLogin }) => maybeLogin,
    },
    () => Option.none(),
  );
}

function withLogin(chatgpt: ChatGPT, login: PendingLogin): ChatGPT {
  return ChatGPT.matchOrElse(
    chatgpt,
    {
      Disconnected: () => ChatGPT.Disconnected({ maybeLogin: Option.some(login) }),
      NeedsReconnect: ({ reason }) =>
        ChatGPT.NeedsReconnect({ reason, maybeLogin: Option.some(login) }),
    },
    () => chatgpt,
  );
}

export function withAddress(chatgpt: ChatGPT, address: string): ChatGPT {
  return Option.match(pendingLogin(chatgpt), {
    onNone: () => chatgpt,
    onSome: (login) => withLogin(chatgpt, { ...login, address }),
  });
}

export function keepingAddress(previous: ChatGPT, next: ChatGPT): ChatGPT {
  return Option.match(Option.all({ before: pendingLogin(previous), after: pendingLogin(next) }), {
    onNone: () => next,
    onSome: ({ before, after }) =>
      before.attemptId === after.attemptId
        ? withLogin(next, { ...after, address: before.address })
        : next,
  });
}

const ChatGPTView = Schema.Struct({
  connection: Schema.Struct({
    state: Schema.String,
    reason: Schema.optional(Schema.String),
    usageLimit: Schema.optional(
      Schema.Struct({ reachedAt: Schema.Number, limitedUntil: Schema.NullOr(Schema.Number) }),
    ),
  }),
  login: Schema.NullOr(Schema.Struct({ attemptId: Schema.String, authorizeUrl: Schema.String })),
  model: Schema.String,
});

const decodeChatGPTView = Schema.decodeUnknownOption(ChatGPTView);

function chatGPTLogin(login: (typeof ChatGPTView.Type)["login"]): Option.Option<PendingLogin> {
  if (login === null || login.attemptId === "" || login.authorizeUrl === "") {
    return Option.none();
  }

  return Option.some({ attemptId: login.attemptId, authorizeUrl: login.authorizeUrl, address: "" });
}

function usageLimitOf(
  limit: NonNullable<(typeof ChatGPTView.Type)["connection"]["usageLimit"]>,
): UsageLimit {
  return UsageLimit.Limited({
    maybeUntil: limit.limitedUntil === null ? Option.none() : Option.some(limit.limitedUntil),
  });
}

export function chatGPTConnection(view: Schema.Json): ChatGPT {
  const decoded = Option.getOrUndefined(decodeChatGPTView(view));

  if (decoded === undefined) return ChatGPT.Unknown();

  const maybeLogin = chatGPTLogin(decoded.login);

  switch (decoded.connection.state) {
    case "disconnected":
      return ChatGPT.Disconnected({ maybeLogin });
    case "connected":
      return ChatGPT.Connected({
        model: decoded.model,
        usageLimit:
          decoded.connection.usageLimit === undefined
            ? UsageLimit.Clear()
            : usageLimitOf(decoded.connection.usageLimit),
      });
    case "needs-reconnect":
      return ChatGPT.NeedsReconnect({
        reason: decoded.connection.reason ?? "",
        maybeLogin,
      });
    default:
      return ChatGPT.Unknown();
  }
}
