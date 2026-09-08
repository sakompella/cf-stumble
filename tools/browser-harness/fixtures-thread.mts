import {
  CONNECTED_PROJECT_ID,
  CONNECTED_PROJECT_URL,
  HARNESS_LOCATION,
  HARNESS_PROJECT_ID,
  HARNESS_PROJECT_URL,
  HARNESS_SELF_PROJECT_ID,
} from "./fixtures.mjs";
import type { JsonValue } from "./json.mjs";

/**
 * The saved thread of each project, built from the count the server is holding.
 *
 * The conversation is the string form the thread row holds — a JSON array of stored Pi messages —
 * and the first two messages name the project and where it is checked out. That is what lets a
 * case tell one project's saved conversation from another's instead of trusting that a re-render
 * happened: a page that kept the previous project's transcript shows the previous project's id.
 */

export type ThreadState = Readonly<{ revision: number; messageCount: number }>;

export const INITIAL_THREAD: ThreadState = { revision: 3, messageCount: 2 };

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

function savedMessageText(projectId: string, index: number): string {
  const location = projectLocation(projectId);
  if (index === 0) {
    return `Read the README of ${projectId} at ${location} and say what it is.`;
  }
  if (index === 1) {
    return `${projectId} is checked out at ${location}. ${threadMarker(projectId)}`;
  }
  return index % 2 === 0
    ? `Ask ${projectId} something else (message ${index + 1}).`
    : `Answer ${index + 1} about ${projectId}.`;
}

function savedMessage(projectId: string, index: number): JsonValue {
  return {
    role: index % 2 === 0 ? "user" : "assistant",
    content: [{ type: "text", text: savedMessageText(projectId, index) }],
  };
}

export function threadPayload(projectId: string, thread: ThreadState): JsonValue {
  const messages = Array.from({ length: thread.messageCount }, (_unused, index) =>
    savedMessage(projectId, index),
  );
  return {
    ok: true,
    thread: {
      projectId,
      conversation: JSON.stringify(messages),
      messageCount: thread.messageCount,
      revision: thread.revision,
      turnActive: false,
      turnDeadlineAt: null,
    },
  };
}
