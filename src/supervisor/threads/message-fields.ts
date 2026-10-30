import type { AgentMessage } from "@cf-stumble/pi";

export type ThreadMessageRole = AgentMessage["role"];

type MessageOfRole<R extends ThreadMessageRole> = Extract<AgentMessage, { role: R }>;

/** A `pi-owned` field is Pi's schema: storage keeps its bytes and reads nothing inside, since a copy here would fork it. */
export type StoredFieldRule =
  | "string"
  | "optional-string"
  | "number"
  | "optional-number"
  | "boolean"
  | "optional-boolean"
  | "pi-owned"
  | "optional-pi-owned";

/** The `-?` makes a field Pi declares optional still need a rule, so a forgotten field is a type error. */
type StoredFields<R extends ThreadMessageRole> = {
  readonly [K in Exclude<keyof MessageOfRole<R>, "role">]-?: StoredFieldRule;
};

interface StoredFieldRules {
  readonly [field: string]: StoredFieldRule;
}

/** The whole schema: serializing and parsing use these fields, and both mapped types are exhaustive, so a new Pi variant or field is a type error. */
export const THREAD_MESSAGE_FIELDS = {
  user: {
    content: "pi-owned",
    timestamp: "number",
  },
  assistant: {
    content: "pi-owned",
    api: "string",
    provider: "string",
    model: "string",
    responseModel: "optional-string",
    responseId: "optional-string",
    diagnostics: "optional-pi-owned",
    usage: "pi-owned",
    stopReason: "string",
    deferred: "optional-pi-owned",
    errorMessage: "optional-string",
    rawStopReason: "optional-string",
    endTurn: "optional-boolean",
    timestamp: "number",
  },
  toolResult: {
    toolCallId: "string",
    toolName: "string",
    content: "pi-owned",
    details: "optional-pi-owned",
    usage: "optional-pi-owned",
    addedToolNames: "optional-pi-owned",
    isError: "boolean",
    timestamp: "number",
  },
  bashExecution: {
    command: "string",
    output: "string",
    // Pi declares this `number | undefined`, not optional: a cancelled command reports no exit code.
    exitCode: "optional-number",
    cancelled: "boolean",
    truncated: "boolean",
    fullOutputPath: "optional-string",
    timestamp: "number",
    excludeFromContext: "optional-boolean",
  },
  custom: {
    customType: "string",
    content: "pi-owned",
    display: "boolean",
    details: "optional-pi-owned",
    timestamp: "number",
  },
  branchSummary: {
    summary: "string",
    fromId: "string",
    timestamp: "number",
  },
  compactionSummary: {
    summary: "string",
    tokensBefore: "number",
    timestamp: "number",
  },
} satisfies { readonly [R in ThreadMessageRole]: StoredFields<R> };

export function storedFieldRules(role: ThreadMessageRole): StoredFieldRules {
  return THREAD_MESSAGE_FIELDS[role];
}
