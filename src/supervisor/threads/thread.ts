import type { AgentMessage } from "@cf-stumble/pi";
import { serializeThreadMessages } from "./messages.js";
import type { ProjectId } from "../../project-catalog.js";

/**
 * A project's one current Pi thread (ADR-0038). `messages` is the whole conversation in order.
 *
 * `revision` is the thread's monotonic concurrency version, and what a caller must present to be
 * admitted to a turn. It advances on every committed turn and on every fresh thread, and never
 * repeats for a project. Counting only committed turns would restart at zero after a fresh
 * thread, and a caller that read the replaced conversation could then be admitted into its
 * replacement because its stale number happened to match again.
 *
 * `turnActive` and `turnDeadlineAt` describe the turn lease, which is a separate concern from the
 * conversation: it decides who may write next, not what has been said. The lease id itself stays
 * in storage and goes only to the caller admitted to that turn.
 */
export type ProjectThread = Readonly<{
  projectId: ProjectId;
  messages: readonly AgentMessage[];
  revision: number;
  turnActive: boolean;
  turnDeadlineAt: number | undefined;
}>;

export type ThreadProblem =
  | Readonly<{ code: "stale-revision"; projectId: ProjectId; currentRevision: number }>
  | Readonly<{ code: "turn-conflict"; projectId: ProjectId; deadlineAt: number }>
  | Readonly<{ code: "turn-not-active"; projectId: ProjectId }>
  | Readonly<{ code: "turn-expired"; projectId: ProjectId; deadlineAt: number }>
  | Readonly<{ code: "turn-lease-lost"; projectId: ProjectId }>
  /** The Supervisor wrote this row and cannot read it back, so the row is damaged. */
  | Readonly<{ code: "unreadable-thread"; projectId: ProjectId; reason: string }>;

export type ThreadResult =
  | Readonly<{ ok: true; thread: ProjectThread }>
  | Readonly<{ ok: false; problem: ThreadProblem }>;

/**
 * What a caller sending a project id can be told. The two extra codes are the catalog's, because a
 * client names a project by a string and the server decides whether that string is a project at
 * all before any thread exists to report a problem about.
 */
export type ProjectThreadProblem =
  | ThreadProblem
  | Readonly<{ code: "invalid-project-id" | "unknown-project-id" }>
  /** The caller sent something that is not a Pi conversation, so nothing was written. */
  | Readonly<{ code: "invalid-messages"; projectId: ProjectId; reason: string }>;

/**
 * A thread on its way out of the Durable Object, with the conversation in the form the row holds.
 *
 * Workers RPC decides at the type level whether a value can be structured-cloned, and its check
 * rejects any type containing `unknown`. Pi declares `CustomMessage.details` and a diagnostic's
 * `details` as `unknown`, so `AgentMessage` fails that check even though every message is plain
 * JSON that clones perfectly at runtime. A method returning `ProjectThread` therefore loses its
 * success arm at the call site, and a caller could never reach the thread it asked for. The bytes
 * cross instead, which is also what ADR-0035 asks of a value leaving this isolate; a caller that
 * wants Pi messages back calls `parseThreadMessages` on them.
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

/**
 * What admission to a turn returns: the thread the turn holds, and the lease id that may finish
 * or abandon it. This is the only place a lease id leaves the Supervisor, and it goes to the
 * caller that was just admitted. The read and fresh-thread surfaces return a thread without one,
 * so a client that never started a turn cannot learn the lease of one that is running.
 */
export type ProjectTurnLeaseResult =
  | { readonly ok: true; readonly thread: SerializedThread; readonly leaseId: string }
  | { readonly ok: false; readonly problem: ProjectThreadProblem };

export function emptyThread(projectId: ProjectId): ProjectThread {
  return { projectId, messages: [], revision: 0, turnActive: false, turnDeadlineAt: undefined };
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
