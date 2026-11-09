import * as Data from "effect/Data";
import * as Schema from "effect/Schema";
import type { ChatGPTAccess } from "./connection-view.js";

const REFRESH_WINDOW_MS = 8 * 60 * 1000;

const ReconnectReason = Schema.Literals(["refresh-refused", "provider-refused", "missing-scope"]);

export type ReconnectReason = typeof ReconnectReason.Type;

const UsageLimit = Schema.Struct({
  reachedAt: Schema.Number,
  limitedUntil: Schema.NullOr(Schema.Number),
});

export type UsageLimit = typeof UsageLimit.Type;

export const ChatGPTAccount = Schema.TaggedUnion({
  disconnected: {},
  connected: {
    accessToken: Schema.String,
    refreshToken: Schema.String,
    expiresAt: Schema.Number,
    clientId: Schema.String,
    usageLimit: Schema.NullOr(UsageLimit),
  },
  needsReconnect: { reason: ReconnectReason },
});

export type ChatGPTAccount = typeof ChatGPTAccount.Type;

export type ConnectedAccount = typeof ChatGPTAccount.cases.connected.Type;

export type Grant = Readonly<{
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  clientId: string;
}>;

export type AccountEvent = Data.TaggedEnum<{
  LoggedIn: { readonly grant: Grant };
  Refreshed: { readonly redeemed: string; readonly grant: Omit<Grant, "clientId"> };
  RefreshRefused: {
    readonly accessToken: string;
    readonly reason: Exclude<ReconnectReason, "provider-refused">;
  };
  ProviderRefused: { readonly accessToken: string };
  LimitReported: {
    readonly accessToken: string;
    readonly reachedAt: number;
    readonly limitedUntil: number | null;
  };
  LimitLapsed: { readonly now: number };
  Disconnected: object;
}>;

export const AccountEvent = Data.taggedEnum<AccountEvent>();

export type AccessStep = Data.TaggedEnum<{
  Answer: { readonly access: ChatGPTAccess };
  Refresh: { readonly from: ConnectedAccount };
}>;

export const AccessStep = Data.taggedEnum<AccessStep>();

const DISCONNECTED = ChatGPTAccount.cases.disconnected.make({});

function connected(fields: Grant, usageLimit: UsageLimit | null): ChatGPTAccount {
  return ChatGPTAccount.cases.connected.make({
    accessToken: fields.accessToken,
    refreshToken: fields.refreshToken,
    expiresAt: fields.expiresAt,
    clientId: fields.clientId,
    usageLimit,
  });
}

function whenConnected(
  account: ChatGPTAccount,
  step: (current: ConnectedAccount) => ChatGPTAccount,
): ChatGPTAccount {
  return ChatGPTAccount.match(account, {
    disconnected: (current) => current,
    needsReconnect: (current) => current,
    connected: step,
  });
}

function holding(account: ConnectedAccount, accessToken: string): boolean {
  return account.accessToken === accessToken;
}

export function blockingLimit(limit: UsageLimit | null, now: number): number | null {
  return limit !== null && limit.limitedUntil !== null && limit.limitedUntil > now
    ? limit.limitedUntil
    : null;
}

function reportedLimit(
  known: UsageLimit | null,
  reachedAt: number,
  limitedUntil: number | null,
): UsageLimit {
  return limitedUntil === null && known !== null && blockingLimit(known, reachedAt) !== null
    ? known
    : { reachedAt, limitedUntil };
}

function reconnect(current: ConnectedAccount, accessToken: string, reason: ReconnectReason) {
  return holding(current, accessToken)
    ? ChatGPTAccount.cases.needsReconnect.make({ reason })
    : current;
}

export function transition(account: ChatGPTAccount, event: AccountEvent): ChatGPTAccount {
  return AccountEvent.$match(event, {
    LoggedIn: ({ grant }) => connected(grant, null),
    Disconnected: () => DISCONNECTED,
    Refreshed: ({ redeemed, grant }) =>
      whenConnected(account, (current) =>
        current.refreshToken === redeemed
          ? connected({ ...grant, clientId: current.clientId }, current.usageLimit)
          : current,
      ),
    RefreshRefused: ({ accessToken, reason }) =>
      whenConnected(account, (current) => reconnect(current, accessToken, reason)),
    ProviderRefused: ({ accessToken }) =>
      whenConnected(account, (current) => reconnect(current, accessToken, "provider-refused")),
    LimitReported: ({ accessToken, reachedAt, limitedUntil }) =>
      whenConnected(account, (current) =>
        holding(current, accessToken)
          ? connected(current, reportedLimit(current.usageLimit, reachedAt, limitedUntil))
          : current,
      ),
    LimitLapsed: ({ now }) =>
      whenConnected(account, (current) =>
        current.usageLimit === null || blockingLimit(current.usageLimit, now) !== null
          ? current
          : connected(current, null),
      ),
  });
}

function storedAccess(account: ChatGPTAccount): ChatGPTAccess {
  return ChatGPTAccount.match(account, {
    disconnected: (): ChatGPTAccess => ({ kind: "not-connected" }),
    needsReconnect: (): ChatGPTAccess => ({ kind: "reconnect-required" }),
    connected: ({ accessToken }): ChatGPTAccess => ({ kind: "ready", accessToken }),
  });
}

export function decideAccess(
  account: ChatGPTAccount,
  now: number,
  rejected: string | undefined,
): AccessStep {
  return ChatGPTAccount.match(account, {
    disconnected: (current) => AccessStep.Answer({ access: storedAccess(current) }),
    needsReconnect: (current) => AccessStep.Answer({ access: storedAccess(current) }),
    connected: (current) => {
      const limitedUntil = blockingLimit(current.usageLimit, now);

      if (limitedUntil !== null) {
        return AccessStep.Answer({ access: { kind: "usage-limited", limitedUntil } });
      }

      const fresh = current.expiresAt - now >= REFRESH_WINDOW_MS;

      return fresh && rejected !== current.accessToken
        ? AccessStep.Answer({ access: storedAccess(current) })
        : AccessStep.Refresh({ from: current });
    },
  });
}

export function refreshAccess(
  after: ChatGPTAccount,
  from: ConnectedAccount,
  now: number,
  rejected: string | undefined,
): ChatGPTAccess {
  const unchanged = ChatGPTAccount.guards.connected(after) && holding(after, from.accessToken);

  if (!unchanged) return storedAccess(after);

  return rejected !== from.accessToken && from.expiresAt > now
    ? { kind: "ready", accessToken: from.accessToken }
    : { kind: "unavailable" };
}
