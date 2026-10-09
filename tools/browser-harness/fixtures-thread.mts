import {
  CONNECTED_PROJECT_ID,
  CONNECTED_PROJECT_URL,
  HARNESS_LOCATION,
  HARNESS_PROJECT_ID,
  HARNESS_PROJECT_URL,
  HARNESS_SELF_PROJECT_ID,
} from "./fixtures.mjs";
import type { JsonValue } from "../json.mjs";
import { textMessage, type StoredMessage } from "./turn-messages.mjs";

/**
 * The saved thread of each project, as the stub stores it.
 *
 * The conversation is the string form the thread row holds — a JSON array of stored Pi messages —
 * and the first two messages name the project and where it is checked out. A turn appends what it
 * streamed (`turn-messages.mts`), so a reload reads back the turn itself, not a count. That is what lets a
 * case tell one project's saved conversation from another's instead of trusting that a re-render
 * happened: a page that kept the previous project's transcript shows the previous project's id.
 */

/** What a case may ask of a stored thread: its revision and how many messages it holds. */
export type ThreadState = Readonly<{ revision: number; messageCount: number }>;

/** What the stub stores for one project: the thread row's revision and its Pi messages. */
export type StoredThread = Readonly<{ revision: number; messages: readonly StoredMessage[] }>;

export const INITIAL_REVISION = 3;

/** The marker that proves the reader is looking at this project's own stored conversation. */
export const HARNESS_THREAD_MARKER = "HARNESS-THREAD";

export const EARLIER_EDIT_MARKER = "EARLIER-EDIT-KEPT";

export function projectLocation(projectId: string): string {
  if (projectId === HARNESS_SELF_PROJECT_ID) {
    return HARNESS_LOCATION;
  }

  if (projectId === HARNESS_PROJECT_ID) {
    return HARNESS_PROJECT_URL;
  }

  if (projectId === CONNECTED_PROJECT_ID) {
    return CONNECTED_PROJECT_URL;
  }

  return `/workspace/projects/${projectId}`;
}

function threadMarker(projectId: string): string {
  return projectId === HARNESS_SELF_PROJECT_ID ? HARNESS_THREAD_MARKER : EARLIER_EDIT_MARKER;
}

/** Every project starts at revision 3 with one exchange that names the project and its location. */
export function initialThread(projectId: string): StoredThread {
  const location = projectLocation(projectId);

  return {
    revision: INITIAL_REVISION,
    messages: [
      textMessage("user", `Read the README of ${projectId} at ${location} and say what it is.`),
      textMessage(
        "assistant",
        `${projectId} is checked out at ${location}. ${threadMarker(projectId)}`,
      ),
    ],
  };
}

export function threadSummary(thread: StoredThread): ThreadState {
  return { revision: thread.revision, messageCount: thread.messages.length };
}

export function threadPayload(projectId: string, thread: StoredThread): JsonValue {
  return {
    ok: true,
    thread: {
      projectId,
      conversation: JSON.stringify(thread.messages),
      messageCount: thread.messages.length,
      revision: thread.revision,
      turnActive: false,
      turnDeadlineAt: null,
    },
  };
}
