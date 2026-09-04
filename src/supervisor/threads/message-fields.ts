import type { AgentMessage } from "@cf-stumble/pi";

/** The roles Pi's `AgentMessage` union carries: three LLM messages and four harness messages. */
export type ThreadMessageRole = AgentMessage["role"];

type MessageOfRole<R extends ThreadMessageRole> = Extract<AgentMessage, { role: R }>;

/**
 * What storage may assume about one declared field of one message.
 *
 * A `pi-owned` field holds a structure whose schema belongs to Pi: a content block, a usage
 * record, a deferred handle, a tool call's arguments, a custom message's details. Storage keeps
 * those bytes and reads nothing inside them, for the reason `parsePiAgentTurnState` gives on the
 * facet side: a copy of Pi's schema here would fork it, and the next Pi upgrade would break
 * against a thread this code wrote. The kinds that are checked are the ones storage itself relies
 * on, so a corrupt row cannot present a message whose discriminating fields are the wrong kind.
 */
export type StoredFieldRule =
  | "string"
  | "optional-string"
  | "number"
  | "optional-number"
  | "boolean"
  | "optional-boolean"
  | "pi-owned"
  | "optional-pi-owned";

/**
 * Every field of one variant except its `role`, which the record below supplies as the key. The
 * `-?` strips optionality so a field Pi declares optional still needs a rule, which is what makes
 * a forgotten field a type error rather than a field silently dropped on the way to SQLite.
 */
type StoredFields<R extends ThreadMessageRole> = {
  readonly [K in Exclude<keyof MessageOfRole<R>, "role">]-?: StoredFieldRule;
};

/** The field rules of one role, read without knowing which role it is. */
export interface StoredFieldRules {
  readonly [field: string]: StoredFieldRule;
}

/**
 * The stored shape of every `AgentMessage` variant, field by field.
 *
 * This record is the whole schema. Serialization copies the fields named here and parsing accepts
 * the fields named here, so the two halves cannot drift apart. Both mapped types are exhaustive:
 * a variant added to Pi's union leaves a missing key here, and a field added to a variant leaves a
 * missing key inside it.
 */
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
    // Pi declares this required and nullable: a cancelled command reports no exit code.
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
