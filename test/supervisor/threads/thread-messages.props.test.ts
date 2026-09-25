// oxlint-disable max-lines, max-lines-per-function, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-unsafe-dictionary-type, typescript/no-unnecessary-type-parameters, anti-slop/require-readable-spacing, typescript/no-unsafe-assignment -- This property enumerates Pi's generated message variants and its JSON boundary.
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { expect, test } from "vitest";
import type { AgentMessage } from "@cf-stumble/pi";

import {
  parseThreadMessages,
  serializeThreadMessages,
} from "../../../src/supervisor/threads/index.js";
import { THREAD_MESSAGE_SAMPLES } from "./message-samples.js";

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { readonly [key: string]: JsonValue };
type Role = AgentMessage["role"];
type UserMessage = Extract<AgentMessage, { role: "user" }>;
type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;
type ToolResultMessage = Extract<AgentMessage, { role: "toolResult" }>;
type BashExecutionMessage = Extract<AgentMessage, { role: "bashExecution" }>;
type CustomMessage = Extract<AgentMessage, { role: "custom" }>;

const roles = gs.sampledFrom([
  "user",
  "assistant",
  "toolResult",
  "bashExecution",
  "custom",
  "branchSummary",
  "compactionSummary",
] as const);
const text = gs.text({ alphabet: "abc XYZ012-é", maxSize: 16 });
const timestamp = gs.integers({ minValue: 0, maxValue: 2 ** 40 });

function drawJson(tc: hegel.TestCase, depth = 0): JsonValue {
  if (depth >= 2) return tc.draw(gs.sampledFrom([null, false, true, 0, 1, "value"] as const));

  switch (
    tc.draw(gs.sampledFrom(["null", "boolean", "number", "string", "array", "object"] as const))
  ) {
    case "null":
      return null;
    case "boolean":
      return tc.draw(gs.booleans());
    case "number":
      return tc.draw(gs.integers({ minValue: -1000, maxValue: 1000 }));
    case "string":
      return tc.draw(text);
    case "array":
      return tc.draw(gs.arrays(gs.integers({ minValue: -100, maxValue: 100 }), { maxSize: 3 }));
    case "object": {
      const result: Record<string, JsonValue> = {};
      const count = tc.draw(gs.integers({ minValue: 0, maxValue: 3 }));
      for (let index = 0; index < count; index += 1)
        result[`nested${index}`] = drawJson(tc, depth + 1);
      return result;
    }
  }

  return null;
}

function optionalString(tc: hegel.TestCase): string | undefined {
  return tc.draw(gs.booleans()) ? tc.draw(text) : undefined;
}

function optionalBoolean(tc: hegel.TestCase): boolean | undefined {
  return tc.draw(gs.booleans()) ? tc.draw(gs.booleans()) : undefined;
}

function optionalJson(tc: hegel.TestCase): JsonValue | undefined {
  return tc.draw(gs.booleans()) ? drawJson(tc) : undefined;
}

function setIfDefined<T extends object>(target: T, key: string, value: unknown): void {
  if (value !== undefined) Object.assign(target, { [key]: value });
}

function drawUserMessage(tc: hegel.TestCase): UserMessage {
  return { ...THREAD_MESSAGE_SAMPLES.user, role: "user", timestamp: tc.draw(timestamp) };
}

function drawAssistantMessage(tc: hegel.TestCase): AssistantMessage {
  const {
    responseModel: _responseModel,
    responseId: _responseId,
    diagnostics: _diagnostics,
    deferred: _deferred,
    errorMessage: _errorMessage,
    rawStopReason: _rawStopReason,
    endTurn: _endTurn,
    ...base
  } = THREAD_MESSAGE_SAMPLES.assistant;
  const message: AssistantMessage = { ...base, role: "assistant", timestamp: tc.draw(timestamp) };

  setIfDefined(message, "responseModel", optionalString(tc));
  setIfDefined(message, "responseId", optionalString(tc));
  setIfDefined(
    message,
    "diagnostics",
    tc.draw(gs.booleans()) ? THREAD_MESSAGE_SAMPLES.assistant.diagnostics : undefined,
  );
  setIfDefined(
    message,
    "deferred",
    tc.draw(gs.booleans()) ? THREAD_MESSAGE_SAMPLES.assistant.deferred : undefined,
  );
  setIfDefined(message, "errorMessage", optionalString(tc));
  setIfDefined(message, "rawStopReason", optionalString(tc));
  setIfDefined(message, "endTurn", optionalBoolean(tc));

  return message;
}

function drawToolResultMessage(tc: hegel.TestCase): ToolResultMessage {
  const {
    details: _details,
    usage: _usage,
    addedToolNames: _addedToolNames,
    ...base
  } = THREAD_MESSAGE_SAMPLES.toolResult;
  const message: ToolResultMessage = {
    ...base,
    role: "toolResult",
    timestamp: tc.draw(timestamp),
  };

  setIfDefined(message, "details", optionalJson(tc));
  setIfDefined(
    message,
    "usage",
    tc.draw(gs.booleans()) ? THREAD_MESSAGE_SAMPLES.toolResult.usage : undefined,
  );
  setIfDefined(
    message,
    "addedToolNames",
    tc.draw(gs.booleans()) ? THREAD_MESSAGE_SAMPLES.toolResult.addedToolNames : undefined,
  );
  return message;
}

function drawBashExecutionMessage(tc: hegel.TestCase): BashExecutionMessage {
  const {
    exitCode: _exitCode,
    fullOutputPath: _fullOutputPath,
    excludeFromContext: _exclude,
    ...base
  } = THREAD_MESSAGE_SAMPLES.bashExecution;
  const message: BashExecutionMessage = {
    ...base,
    role: "bashExecution",
    command: tc.draw(text),
    output: tc.draw(text),
    exitCode: undefined,
    timestamp: tc.draw(timestamp),
  };

  setIfDefined(
    message,
    "exitCode",
    tc.draw(gs.booleans()) ? tc.draw(gs.integers({ minValue: 0, maxValue: 100 })) : undefined,
  );
  setIfDefined(message, "fullOutputPath", optionalString(tc));
  setIfDefined(message, "excludeFromContext", optionalBoolean(tc));
  return message;
}

function drawCustomMessage(tc: hegel.TestCase): CustomMessage {
  const { details: _details, ...base } = THREAD_MESSAGE_SAMPLES.custom;
  const message: CustomMessage = { ...base, role: "custom", timestamp: tc.draw(timestamp) };
  setIfDefined(message, "details", optionalJson(tc));
  return message;
}

function drawMessage(tc: hegel.TestCase, role: Role): AgentMessage {
  switch (role) {
    case "user":
      return drawUserMessage(tc);
    case "assistant":
      return drawAssistantMessage(tc);
    case "toolResult":
      return drawToolResultMessage(tc);
    case "bashExecution":
      return drawBashExecutionMessage(tc);
    case "custom":
      return drawCustomMessage(tc);
    case "branchSummary":
      return { role, summary: tc.draw(text), fromId: tc.draw(text), timestamp: tc.draw(timestamp) };
    case "compactionSummary":
      return {
        role,
        summary: tc.draw(text),
        tokensBefore: tc.draw(gs.integers({ minValue: 0, maxValue: 1000 })),
        timestamp: tc.draw(timestamp),
      };
    default:
      throw new Error("unknown role");
  }
}

function normalizeJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

function parsedMessages(value: string): readonly AgentMessage[] {
  const parsed = parseThreadMessages(value);
  if (parsed.isErr()) throw new Error(parsed.error.reason);
  return parsed.value;
}

test("generated messages round-trip with optional fields and arbitrary order", () => {
  hegel.test((tc) => {
    const messageRoles = tc.draw(gs.arrays(roles, { minSize: 1, maxSize: 8 }));
    const messages = messageRoles.map((role) => drawMessage(tc, role));
    const encoded = serializeThreadMessages(messages);
    const decoded = parsedMessages(encoded);

    expect(decoded).toEqual(normalizeJson(messages));
    expect(JSON.parse(serializeThreadMessages(decoded))).toEqual(JSON.parse(encoded));
    expect(parsedMessages(serializeThreadMessages(decoded))).toEqual(decoded);
  });
});

const requiredFields: Readonly<Record<Role, readonly string[]>> = {
  user: ["content", "timestamp"],
  assistant: ["content", "api", "provider", "model", "usage", "stopReason", "timestamp"],
  toolResult: ["toolCallId", "toolName", "content", "isError", "timestamp"],
  bashExecution: ["command", "output", "cancelled", "truncated", "timestamp"],
  custom: ["customType", "content", "display", "timestamp"],
  branchSummary: ["summary", "fromId", "timestamp"],
  compactionSummary: ["summary", "tokensBefore", "timestamp"],
};

const wrongKindFields: readonly { role: Role; field: string; value: JsonValue }[] = [
  { role: "user", field: "timestamp", value: "wrong" },
  { role: "assistant", field: "api", value: 7 },
  { role: "toolResult", field: "isError", value: "wrong" },
  { role: "bashExecution", field: "timestamp", value: "wrong" },
  { role: "custom", field: "display", value: "wrong" },
  { role: "branchSummary", field: "summary", value: 7 },
  { role: "compactionSummary", field: "tokensBefore", value: "wrong" },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function storedEntry(message: AgentMessage): Record<string, unknown> {
  const decoded: unknown = JSON.parse(serializeThreadMessages([message]));
  if (!Array.isArray(decoded) || !isRecord(decoded[0])) throw new Error("expected one object");
  return decoded[0];
}

function malformedEntry(
  message: AgentMessage,
  mutation: "missing-required" | "unknown-field" | "wrong-kind",
  tc: hegel.TestCase,
): Record<string, unknown> {
  const entry = storedEntry(message);
  switch (mutation) {
    case "missing-required":
      delete entry[tc.draw(gs.sampledFrom(requiredFields[message.role]))];
      return entry;
    case "unknown-field":
      entry.injected = drawJson(tc);
      return entry;
    case "wrong-kind": {
      const target = wrongKindFields.find(({ role }) => role === message.role);
      if (target === undefined) throw new Error("no wrong-kind target");
      entry[target.field] = target.value;
      return entry;
    }
    default:
      throw new Error("unknown mutation");
  }
}

test("generated missing, unknown, and wrong-kind fields are rejected", () => {
  hegel.test((tc) => {
    const message = drawMessage(tc, tc.draw(roles));
    const mutation = tc.draw(
      gs.sampledFrom(["missing-required", "unknown-field", "wrong-kind"] as const),
    );

    expect(
      parseThreadMessages(JSON.stringify([malformedEntry(message, mutation, tc)])).isErr(),
    ).toBe(true);
  });
});

test("parsing arbitrary stored strings never throws", () => {
  hegel.test((tc) => {
    expect(() => parseThreadMessages(tc.draw(gs.text()))).not.toThrow();
  });
});
