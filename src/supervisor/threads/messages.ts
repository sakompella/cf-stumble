// oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof -- This file is the parse boundary for a stored thread. A row read back from SQLite is decoded JSON with no proven shape, so these functions work in open records and runtime kinds until they have proved one.
import * as Data from "effect/Data";
import * as Result from "effect/Result";
import type { AgentMessage } from "@cf-stumble/pi";
import { isRecord } from "../../untrusted.js";
import {
  storedFieldRules,
  THREAD_MESSAGE_FIELDS,
  type StoredFieldRule,
  type ThreadMessageRole,
} from "./message-fields.js";

/** The Supervisor wrote the row, so this means corruption rather than a bad caller. */
export class ThreadMessagesUnreadable extends Data.TaggedError("ThreadMessagesUnreadable")<{
  readonly reason: string;
  readonly message: string;
}> {}

function unreadable(reason: string): Result.Result<never, ThreadMessagesUnreadable> {
  return Result.fail(new ThreadMessagesUnreadable({ reason, message: reason }));
}

function isThreadMessageRole(value: unknown): value is ThreadMessageRole {
  return typeof value === "string" && Object.hasOwn(THREAD_MESSAGE_FIELDS, value);
}

/** Fields holding `undefined` are left out, as the parser expects for an absent optional field. */
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

/** The only place that claims a decoded value is an `AgentMessage`, after checking the role and every declared field. */
function restoredMessage(
  role: ThreadMessageRole,
  fields: readonly (readonly [string, unknown])[],
): AgentMessage {
  const restored: RestoredMessage = { ...Object.fromEntries(fields), role };

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: the caller supplied every field the role declares, of the kind THREAD_MESSAGE_FIELDS names for it, and no field it does not declare.
  return restored as AgentMessage;
}

function parseThreadMessage(value: unknown): Result.Result<AgentMessage, ThreadMessagesUnreadable> {
  if (!isRecord(value)) {
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

  return Result.succeed(restoredMessage(role, fields));
}

export function parseAgentMessages(
  value: unknown,
): Result.Result<readonly AgentMessage[], ThreadMessagesUnreadable> {
  if (!Array.isArray(value)) {
    return unreadable("a thread is not a list of messages");
  }

  const entries: readonly unknown[] = value;
  const messages: AgentMessage[] = [];

  for (const entry of entries) {
    const message = parseThreadMessage(entry);

    if (Result.isFailure(message)) {
      return Result.fail(message.failure);
    }

    messages.push(message.success);
  }

  return Result.succeed(messages);
}

/** An absent or empty column is an empty conversation, not a fault. */
export function parseThreadMessages(
  stored: string | null,
): Result.Result<readonly AgentMessage[], ThreadMessagesUnreadable> {
  if (stored === null || stored === "") {
    return Result.succeed([]);
  }

  let decoded: unknown;

  try {
    decoded = JSON.parse(stored);
  } catch {
    return unreadable("the stored thread is not JSON");
  }

  return parseAgentMessages(decoded);
}
