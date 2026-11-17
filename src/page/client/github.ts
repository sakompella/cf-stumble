import * as Schema from "effect/Schema";
import { defineTaggedUnion } from "foldkit/schema";
import type { AnswerOf } from "../../api/answers.js";
import { checkedWording } from "./api.js";

export const GitHubConnection = defineTaggedUnion({
  Unknown: {},
  Disconnected: {},
  ToolingMissing: {},
  Connected: { login: Schema.String, source: Schema.String },
  ReconnectRequired: { reason: Schema.String },
  AwaitingAuthorization: { verificationUri: Schema.String, userCode: Schema.String },
});

export type GitHubConnection = typeof GitHubConnection.Type;

export const GitHubReading = Schema.Struct({
  connection: GitHubConnection,
  checked: Schema.String,
});

export type GitHubReading = typeof GitHubReading.Type;

export const GitHub = Schema.Struct({
  connection: GitHubConnection,
  checked: Schema.String,
  result: Schema.String,
});

export type GitHub = typeof GitHub.Type;

type GitHubStatusView = AnswerOf<"GET /api/github/connection">["github"];

function gitHubConnection(status: GitHubStatusView): GitHubConnection {
  if (status === null) return GitHubConnection.Unknown();

  if (status.state === "disconnected") return GitHubConnection.Disconnected();

  if (status.state === "tooling-missing") return GitHubConnection.ToolingMissing();

  if (status.state === "connected") {
    return GitHubConnection.Connected({ login: status.login, source: status.source });
  }

  if (status.state === "reconnect-required") {
    return GitHubConnection.ReconnectRequired({ reason: status.reason });
  }

  return GitHubConnection.AwaitingAuthorization({
    verificationUri: status.verificationUri,
    userCode: status.userCode,
  });
}

export function gitHubReading(
  status: GitHubStatusView,
  checkedAt: number | null,
  now: number,
): GitHubReading {
  const connection = gitHubConnection(status);

  return {
    connection,
    checked: GitHubConnection.guards.AwaitingAuthorization(connection)
      ? ""
      : checkedWording(checkedAt, now),
  };
}

export function gitHubWording(connection: GitHubConnection): string {
  return GitHubConnection.match(connection, {
    Unknown: () => "unknown",
    Disconnected: () => "disconnected",
    ToolingMissing: () => "tooling-missing",
    Connected: () => "connected",
    ReconnectRequired: () => "reconnect-required",
    AwaitingAuthorization: () => "awaiting-authorization",
  });
}

export function gitHubDetail(connection: GitHubConnection): string {
  return GitHubConnection.match(connection, {
    Unknown: () => "",
    Disconnected: () => "",
    ToolingMissing: () => "the workspace has no gh command",
    Connected: ({ login, source }) => `${login} (${source})`,
    ReconnectRequired: ({ reason }) => reason,
    AwaitingAuthorization: ({ userCode }) => `enter code ${userCode} at GitHub`,
  });
}
