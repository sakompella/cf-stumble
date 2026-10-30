import type { AgentMessage } from "@cf-stumble/pi";
import { serializeThreadMessages } from "./messages.js";
import type { ProjectId } from "../../project-catalog.js";

/**
 * `revision` advances on every committed turn and every fresh thread and never repeats: counting only
 * commits would restart at zero and admit a caller holding the replaced conversation. The lease id
 * stays in storage.
 */
export type ProjectThread = Readonly<{
  projectId: ProjectId;
  messages: readonly AgentMessage[];
  revision: number;
  turnActive: boolean;
  turnDeadlineAt: number | undefined;
  turnHolderId?: string | undefined;
}>;

export type ThreadProblem =
  | Readonly<{ code: "stale-revision"; projectId: ProjectId; currentRevision: number }>
  | Readonly<{ code: "turn-conflict"; projectId: ProjectId; deadlineAt: number }>
  | Readonly<{ code: "turn-not-active"; projectId: ProjectId }>
  | Readonly<{ code: "turn-expired"; projectId: ProjectId; deadlineAt: number }>
  | Readonly<{ code: "turn-lease-lost"; projectId: ProjectId }>
  | Readonly<{ code: "turn-active"; projectId: ProjectId; deadlineAt: number }>
  | Readonly<{ code: "unreadable-thread"; projectId: ProjectId; reason: string }>;

/** The two extra codes are the catalog's: the server decides whether a client's string is a project before any thread exists. */
export type ProjectThreadProblem =
  | ThreadProblem
  | Readonly<{ code: "invalid-project-id" | "unknown-project-id" }>
  | Readonly<{ code: "invalid-messages"; projectId: ProjectId; reason: string }>;

/**
 * The conversation as bytes: Workers RPC types reject `unknown`, which Pi's `CustomMessage.details`
 * contains, so `AgentMessage` would lose the success arm at the call site. Use `parseThreadMessages`.
 */
export type SerializedThread = Readonly<{
  projectId: ProjectId;
  conversation: string;
  messageCount: number;
  revision: number;
  turnActive: boolean;
  turnDeadlineAt: number | undefined;
}>;

export type ProjectThreadResult =
  | { readonly ok: true; readonly thread: SerializedThread }
  | { readonly ok: false; readonly problem: ProjectThreadProblem };

/** The only place a lease id leaves the Supervisor, so a client that never started a turn cannot learn a running turn's lease. */
export type ProjectTurnLeaseResult =
  | {
      readonly ok: true;
      readonly thread: SerializedThread;
      readonly leaseId: string;
      readonly reclaimed?: boolean;
    }
  | { readonly ok: false; readonly problem: ProjectThreadProblem };

export function emptyThread(projectId: ProjectId): ProjectThread {
  return {
    projectId,
    messages: [],
    revision: 0,
    turnActive: false,
    turnDeadlineAt: undefined,
    turnHolderId: undefined,
  };
}

export function serializedThread(thread: ProjectThread): SerializedThread {
  return {
    projectId: thread.projectId,
    conversation: serializeThreadMessages(thread.messages),
    messageCount: thread.messages.length,
    revision: thread.revision,
    turnActive: thread.turnActive,
    turnDeadlineAt: thread.turnDeadlineAt,
  };
}
