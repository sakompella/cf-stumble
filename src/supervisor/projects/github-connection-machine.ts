import * as Data from "effect/Data";
import * as Schema from "effect/Schema";
import type { GitHubCredentialStatus } from "../../github/index.js";

export const CredentialSource = Schema.Literals(["device-authorization", "configured-token"]);

export type CredentialSource = typeof CredentialSource.Type;

const Recorded = Schema.Struct({
  login: Schema.String,
  source: CredentialSource,
});

export type Recorded = typeof Recorded.Type;

export const ReconnectReason = Schema.Literals(["credential-missing", "credential-rejected"]);

export type ReconnectReason = typeof ReconnectReason.Type;

export const GitHubCredential = Schema.TaggedUnion({
  unchecked: {},
  disconnected: { checkedAt: Schema.Number },
  toolingMissing: { checkedAt: Schema.Number, recorded: Schema.NullOr(Recorded) },
  connected: {
    checkedAt: Schema.Number,
    login: Schema.String,
    source: CredentialSource,
  },
  reconnectRequired: {
    checkedAt: Schema.Number,
    reason: ReconnectReason,
    recorded: Schema.NullOr(Recorded),
  },
});

export type GitHubCredential = typeof GitHubCredential.Type;

export const GitHubAuthorization = Schema.TaggedUnion({
  idle: {},
  pending: {
    deviceCode: Schema.String,
    userCode: Schema.String,
    verificationUri: Schema.String,
    expiresAt: Schema.Number,
  },
});

export type GitHubAuthorization = typeof GitHubAuthorization.Type;

type PendingAuthorization = typeof GitHubAuthorization.cases.pending.Type;

export type CredentialEvent = Data.TaggedEnum<{
  Observed: {
    readonly answer: GitHubCredentialStatus;
    readonly installedBy: CredentialSource | undefined;
    readonly now: number;
  };
  InstallRefused: { readonly now: number };
}>;

export const CredentialEvent = Data.taggedEnum<CredentialEvent>();

export type AuthorizationEvent = Data.TaggedEnum<{
  Started: { readonly pending: PendingAuthorization };
  Elapsed: { readonly now: number };
  Settled: { readonly deviceCode: string };
}>;

export const AuthorizationEvent = Data.taggedEnum<AuthorizationEvent>();

export type CheckedStatus =
  | Readonly<{ state: "disconnected" }>
  | Readonly<{ state: "tooling-missing" }>
  | Readonly<{ state: "connected"; login: string; source: CredentialSource }>
  | Readonly<{ state: "reconnect-required"; reason: ReconnectReason }>;

export type GitHubConnectionStatus =
  | CheckedStatus
  | Readonly<{
      state: "awaiting-authorization";
      verificationUri: string;
      userCode: string;
      expiresAt: number;
    }>;

export function recordedOf(credential: GitHubCredential): Recorded | null {
  return GitHubCredential.match(credential, {
    unchecked: () => null,
    disconnected: () => null,
    toolingMissing: ({ recorded }) => recorded,
    connected: ({ login, source }) => ({ login, source }),
    reconnectRequired: ({ recorded }) => recorded,
  });
}

export function checkedAtOf(credential: GitHubCredential): number | null {
  return GitHubCredential.match(credential, {
    unchecked: () => null,
    disconnected: ({ checkedAt }) => checkedAt,
    toolingMissing: ({ checkedAt }) => checkedAt,
    connected: ({ checkedAt }) => checkedAt,
    reconnectRequired: ({ checkedAt }) => checkedAt,
  });
}

function reconnectRequired(
  reason: ReconnectReason,
  recorded: Recorded | null,
  now: number,
): GitHubCredential {
  return GitHubCredential.cases.reconnectRequired.make({ checkedAt: now, reason, recorded });
}

function observed(
  recorded: Recorded | null,
  answer: GitHubCredentialStatus,
  installedBy: CredentialSource | undefined,
  now: number,
): GitHubCredential {
  switch (answer.state) {
    case "connected":
      return GitHubCredential.cases.connected.make({
        checkedAt: now,
        login: answer.login,
        source: installedBy ?? recorded?.source ?? "device-authorization",
      });
    case "tooling-missing":
      return GitHubCredential.cases.toolingMissing.make({ checkedAt: now, recorded });
    case "missing":
      return recorded === null
        ? GitHubCredential.cases.disconnected.make({ checkedAt: now })
        : reconnectRequired("credential-missing", recorded, now);
    case "unusable":
      return reconnectRequired("credential-rejected", recorded, now);
    default: {
      const exhaustive: never = answer;

      return exhaustive;
    }
  }
}

export function credentialTransition(
  credential: GitHubCredential,
  event: CredentialEvent,
): GitHubCredential {
  const recorded = recordedOf(credential);

  return CredentialEvent.$match(event, {
    Observed: ({ answer, installedBy, now }) => observed(recorded, answer, installedBy, now),
    InstallRefused: ({ now }) => reconnectRequired("credential-rejected", recorded, now),
  });
}

export function authorizationTransition(
  authorization: GitHubAuthorization,
  event: AuthorizationEvent,
): GitHubAuthorization {
  return AuthorizationEvent.$match(event, {
    Started: ({ pending }) => GitHubAuthorization.cases.pending.make(pending),
    Elapsed: ({ now }) =>
      GitHubAuthorization.match(authorization, {
        idle: () => authorization,
        pending: ({ expiresAt }) =>
          expiresAt <= now ? GitHubAuthorization.cases.idle.make({}) : authorization,
      }),
    Settled: ({ deviceCode }) =>
      GitHubAuthorization.match(authorization, {
        idle: () => authorization,
        pending: (pending) =>
          pending.deviceCode === deviceCode
            ? GitHubAuthorization.cases.idle.make({})
            : authorization,
      }),
  });
}

export function checkedStatus(credential: GitHubCredential): CheckedStatus {
  return GitHubCredential.match(credential, {
    unchecked: () => ({ state: "disconnected" as const }),
    disconnected: () => ({ state: "disconnected" as const }),
    toolingMissing: () => ({ state: "tooling-missing" as const }),
    connected: ({ login, source }) => ({ state: "connected" as const, login, source }),
    reconnectRequired: ({ reason }) => ({ state: "reconnect-required" as const, reason }),
  });
}

export function awaitingStatus(authorization: GitHubAuthorization): GitHubConnectionStatus | null {
  return GitHubAuthorization.match(authorization, {
    idle: () => null,
    pending: ({ verificationUri, userCode, expiresAt }) => ({
      state: "awaiting-authorization" as const,
      verificationUri,
      userCode,
      expiresAt,
    }),
  });
}

export function knownStatus(
  credential: GitHubCredential,
  authorization: GitHubAuthorization,
): GitHubConnectionStatus | null {
  if (GitHubCredential.guards.unchecked(credential)) return awaitingStatus(authorization);

  return awaitingStatus(authorization) ?? checkedStatus(credential);
}

export function isWorking(credential: GitHubCredential): boolean {
  return GitHubCredential.guards.connected(credential);
}

export function needsRepair(credential: GitHubCredential): boolean {
  return GitHubCredential.match(credential, {
    unchecked: () => true,
    disconnected: () => true,
    reconnectRequired: () => true,
    toolingMissing: () => false,
    connected: () => false,
  });
}
