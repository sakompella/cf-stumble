import type { AgentMessage } from "@cf-stumble/pi";

/**
 * One fully populated sample per `AgentMessage` variant.
 *
 * The mapped type is the point. Pi's union is open: `CustomAgentMessages` grows by declaration
 * merging, so a harness that adds a message type adds a member to `AgentMessage["role"]` and this
 * record stops compiling until a sample for it exists. A hand-written list would have gone quiet
 * instead, and the round-trip test would have kept passing while a variant nobody stored went
 * unchecked.
 *
 * Every field each variant declares carries a defined, distinguishable value, including the
 * optional ones. That is what makes a serializer that forgets a field visible: `toEqual` ignores
 * properties that are `undefined` on both sides, so a sample that left a field out would compare
 * equal to a round trip that dropped it.
 */
export type ThreadMessageSamples = {
  readonly [R in AgentMessage["role"]]: Extract<AgentMessage, { role: R }>;
};

const TIMESTAMP = 1_700_000_000_000;

export const THREAD_MESSAGE_SAMPLES: ThreadMessageSamples = {
  user: {
    role: "user",
    content: [
      { type: "text", text: "rename the helper", textSignature: "user-text-signature" },
      { type: "image", data: "aW1hZ2UtYnl0ZXM=", mimeType: "image/png" },
    ],
    timestamp: TIMESTAMP,
  },
  assistant: {
    role: "assistant",
    content: [
      { type: "text", text: "renaming it now", textSignature: "assistant-text-signature" },
      {
        type: "thinking",
        thinking: "the helper is only called from one place",
        thinkingSignature: "assistant-thinking-signature",
        redacted: false,
      },
      {
        type: "toolCall",
        id: "call-1",
        name: "edit_file",
        arguments: { path: "src/helper.ts", find: "oldName", replace: "newName" },
        thoughtSignature: "assistant-thought-signature",
        namespace: "harness",
      },
    ],
    api: "openai-completions",
    provider: "openai",
    model: "requested-model",
    responseModel: "served-model",
    responseId: "response-1",
    diagnostics: [
      {
        type: "provider-retry",
        timestamp: TIMESTAMP,
        error: { name: "RetryableError", message: "upstream reset", stack: "at x", code: 502 },
        details: { attempt: 2 },
      },
    ],
    usage: {
      input: 11,
      output: 22,
      cacheRead: 3,
      cacheWrite: 4,
      cacheWrite1h: 1,
      reasoning: 7,
      totalTokens: 33,
      cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
    },
    stopReason: "toolUse",
    deferred: {
      provider: "openai",
      modelId: "deferred-model",
      api: "openai-responses",
      id: "deferred-1",
      expiresAt: TIMESTAMP + 60_000,
      pollAfterMs: 500,
      data: { batch: "row-3" },
    },
    errorMessage: "the first attempt was reset",
    rawStopReason: "tool_calls",
    endTurn: false,
    timestamp: TIMESTAMP,
  },
  toolResult: {
    role: "toolResult",
    toolCallId: "call-1",
    toolName: "edit_file",
    content: [
      { type: "text", text: "1 replacement", textSignature: "tool-text-signature" },
      { type: "image", data: "c2NyZWVuc2hvdA==", mimeType: "image/jpeg" },
    ],
    details: { replacements: 1 },
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cacheWrite1h: 0,
      reasoning: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    addedToolNames: ["run_check"],
    isError: false,
    timestamp: TIMESTAMP,
  },
  bashExecution: {
    role: "bashExecution",
    command: "./test.sh",
    output: "2 passing",
    exitCode: 0,
    cancelled: false,
    truncated: true,
    fullOutputPath: "/tmp/full-output.txt",
    timestamp: TIMESTAMP,
    excludeFromContext: false,
  },
  custom: {
    role: "custom",
    customType: "workspace-notice",
    content: [
      { type: "text", text: "the workspace was restarted", textSignature: "custom-signature" },
      { type: "image", data: "bm90aWNl", mimeType: "image/webp" },
    ],
    display: true,
    details: { restarts: 1 },
    timestamp: TIMESTAMP,
  },
  branchSummary: {
    role: "branchSummary",
    summary: "the branch explored the parser and came back",
    fromId: "branch-7",
    timestamp: TIMESTAMP,
  },
  compactionSummary: {
    role: "compactionSummary",
    summary: "earlier turns renamed the helper and ran the check",
    tokensBefore: 12_345,
    timestamp: TIMESTAMP,
  },
};

export const THREAD_MESSAGE_SAMPLE_LIST: readonly AgentMessage[] =
  Object.values(THREAD_MESSAGE_SAMPLES);
