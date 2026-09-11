// oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type -- This file is the parse boundary for a stored thread. A row read back from SQLite is decoded JSON with no proven shape, so these functions work in open records and runtime kinds until they have proved one.
import { Result, TaggedError } from "better-result";
import type { AgentMessage } from "@cf-stumble/pi";
import {
  storedFieldRules,
  THREAD_MESSAGE_FIELDS,
  type StoredFieldRule,
  type ThreadMessageRole,
} from "./message-fields.js";

/**
 * A stored thread that cannot be read back as Pi messages. The Supervisor wrote the row itself, so
 * this means the row was corrupted rather than that a caller sent something bad, and `reason`
 * describes the entry that failed rather than restating the caller's request.
 */
export class ThreadMessagesUnreadable extends TaggedError("ThreadMessagesUnreadable")<{
  readonly reason: string;
  readonly message: string;
}> {}

function unreadable(reason: string): Result<never, ThreadMessagesUnreadable> {
  return Result.err(new ThreadMessagesUnreadable({ reason, message: reason }));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isThreadMessageRole(value: unknown): value is ThreadMessageRole {
  return typeof value === "string" && Object.hasOwn(THREAD_MESSAGE_FIELDS, value);
}

/**
 * Encode the thread for its SQLite column. Each message keeps exactly the fields its role declares
 * in {@link THREAD_MESSAGE_FIELDS}, so a field Pi adds without a rule is not silently stored as
 * something the parser would then reject. Fields holding `undefined` are left out, which is what
 * JSON does with them anyway and what the parser expects for an absent optional field.
 */
export function serializeThreadMessages(messages: readonly AgentMessage[]): string {
  return JSON.stringify(messages.map((message) => storedMessage(message)));
}

function storedMessage(message: AgentMessage) {
  const rules = storedFieldRules(message.role);
  const declared: readonly (readonly [string, unknown])[] = Object.entries(message);

  const kept = declared.filter(
    ([field, value]) => value !== undefined && Object.hasOwn(rules, field),
  );

  return Object.fromEntries([["role", message.role], ...kept]);
}

function matchesRule(value: unknown, rule: StoredFieldRule): boolean {
  switch (rule) {
    case "string":
    case "optional-string":
      return typeof value === "string";
    case "number":
    case "optional-number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
    case "optional-boolean":
      return typeof value === "boolean";
    case "pi-owned":
    case "optional-pi-owned":
      return true;
    default: {
      const exhaustive: never = rule;

      return exhaustive;
    }
  }
}

function isOptional(rule: StoredFieldRule): boolean {
  return rule.startsWith("optional-");
}

interface RestoredMessage {
  readonly role: ThreadMessageRole;
}

/**
 * Rebuild one message from its stored fields. This is the only place that claims a decoded value
 * is an `AgentMessage`, and it claims it after checking the role and every field the role
 * declares, so nothing reaches the rest of the Supervisor as a message until it is one.
 */
function restoredMessage(
  role: ThreadMessageRole,
  fields: readonly (readonly [string, unknown])[],
): AgentMessage {
  const restored: RestoredMessage = { ...Object.fromEntries(fields), role };

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: the caller supplied every field the role declares, of the kind THREAD_MESSAGE_FIELDS names for it, and no field it does not declare.
  return restored as AgentMessage;
}

function parseThreadMessage(value: unknown): Result<AgentMessage, ThreadMessagesUnreadable> {
  if (!isPlainObject(value)) {
    return unreadable("a stored thread entry is not an object");
  }

  if (!isThreadMessageRole(value.role)) {
    return unreadable(`a stored thread entry has the unknown role ${JSON.stringify(value.role)}`);
  }

  const role = value.role;
  const rules = storedFieldRules(role);

  const unknownField = Object.keys(value).find(
    (field) => field !== "role" && !Object.hasOwn(rules, field),
  );

  if (unknownField !== undefined) {
    return unreadable(`a stored ${role} message carries the unknown field ${unknownField}`);
  }

  const fields: [string, unknown][] = [];

  for (const [field, rule] of Object.entries(rules)) {
    const stored = value[field];

    if (stored === undefined) {
      if (!isOptional(rule)) {
        return unreadable(`a stored ${role} message has no ${field}`);
      }

      continue;
    }

    if (!matchesRule(stored, rule)) {
      return unreadable(`a stored ${role} message has a ${field} of the wrong kind`);
    }

    fields.push([field, stored]);
  }

  return Result.ok(restoredMessage(role, fields));
}

/**
 * Recognize a decoded list of Pi messages. Both a stored row and a conversation arriving over RPC
 * come through here, so a thread is proved the same way whichever side produced it.
 */
export function parseAgentMessages(
  value: unknown,
): Result<readonly AgentMessage[], ThreadMessagesUnreadable> {
  if (!Array.isArray(value)) {
    return unreadable("a thread is not a list of messages");
  }

  const entries: readonly unknown[] = value;
  const messages: AgentMessage[] = [];

  for (const entry of entries) {
    const message = parseThreadMessage(entry);

    if (message.isErr()) {
      return Result.err(message.error);
    }

    messages.push(message.value);
  }

  return Result.ok(messages);
}

/**
 * Decode a stored thread. An absent or empty column is a thread nobody has written to yet, which
 * is an empty conversation rather than a fault: every catalog project has a thread from the moment
 * it exists.
 */
export function parseThreadMessages(
  stored: string | null,
): Result<readonly AgentMessage[], ThreadMessagesUnreadable> {
  if (stored === null || stored === "") {
    return Result.ok([]);
  }

  let decoded: unknown;

  try {
    decoded = JSON.parse(stored);
  } catch {
    return unreadable("the stored thread is not JSON");
  }

  return parseAgentMessages(decoded);
}
