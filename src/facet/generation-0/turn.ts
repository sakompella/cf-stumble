import {
  assistantEntry,
  parseSessionDocument,
  serializeSessionDocument,
  transcriptToPiMessages,
} from "./session-transcript.js";
import { executeToolPlan } from "./tool-execution.js";
import { GENERATION_0_TOOLS, planToolCall } from "./tools.js";
import {
  isResponseError,
  piContextToRouteRequest,
  routeResponseToPiAssistant,
} from "./workers-ai-adapter.js";
import type { ExecutedCommand } from "./tool-execution.js";
import type { Generation0Capabilities, ModelCapability } from "./capabilities.js";
import type { TranscriptEntry, TranscriptToolCall } from "./session-transcript.js";
import type {
  ModelRouteRequest,
  ModelRouteResponse,
  ValidationFailure,
} from "../../model-route.js";

/**
 * The instructions Generation 0 sends with every turn. They are part of the generation, so a later
 * generation may replace them; nothing outside the facet can set them for this one.
 */
export const GENERATION_0_SYSTEM_PROMPT = [
  "You are cf-stumble, a personal coding agent working in one project workspace.",
  "Use the tools to read and change files and to run the project commands the workspace allows.",
  "Prefer edit_file over write_file when you change part of a file.",
  "Finish by telling the user what you changed and what the commands reported.",
].join(" ");

/**
 * How many model calls one turn may make. The turn is buffered, so the bound is what keeps a
 * tool-calling loop from holding the request open; it is a plainly bounded value, not a measured
 * one.
 */
export const MAX_MODEL_CALLS = 8;

/** What the turn reports when it stops at {@link MAX_MODEL_CALLS} without a final answer. */
export const MODEL_CALL_LIMIT_NOTE = `The turn stopped after ${MAX_MODEL_CALLS} model calls without a final answer.`;

export type TurnRequest = Readonly<{ prompt: string; document: string | null }>;

/** The turn response shape the Supervisor's session store already parses. */
export type TurnResult = Readonly<{
  document: string;
  text: string;
  commands: readonly ExecutedCommand[];
}>;

export type TurnProblem = Readonly<{
  code: "invalid-session-document" | "model-unavailable" | "invalid-model-request";
}>;

export type TurnOutcome =
  | Readonly<{ ok: true; result: TurnResult }>
  | Readonly<{ ok: false; problem: TurnProblem }>;

async function callModel(
  model: ModelCapability,
  request: ModelRouteRequest,
): Promise<ModelRouteResponse | ValidationFailure> {
  try {
    return await model.run(request);
  } catch {
    return { ok: false, error: { code: "model-unavailable" } };
  }
}

function modelProblem(
  failure: Extract<ModelRouteResponse | ValidationFailure, { ok: false }>,
): TurnProblem {
  return {
    code: failure.error.code === "invalid-request" ? "invalid-model-request" : "model-unavailable",
  };
}

function completed(
  entries: readonly TranscriptEntry[],
  texts: readonly string[],
  commands: readonly ExecutedCommand[],
): TurnOutcome {
  return {
    ok: true,
    result: {
      document: serializeSessionDocument(entries),
      text: texts.join("\n\n"),
      commands,
    },
  };
}

type TurnState = Readonly<{
  entries: TranscriptEntry[];
  texts: string[];
  commands: ExecutedCommand[];
}>;

type TurnStep =
  | Readonly<{ kind: "answered" }>
  | Readonly<{ kind: "called-tools" }>
  | Readonly<{ kind: "failed"; problem: TurnProblem }>;

async function runToolCalls(
  capabilities: Generation0Capabilities,
  state: TurnState,
  toolCalls: readonly TranscriptToolCall[],
): Promise<void> {
  for (const toolCall of toolCalls) {
    const outcome = await executeToolPlan(
      capabilities.WORKSPACE,
      planToolCall(toolCall.name, toolCall.arguments),
    );
    state.commands.push(...outcome.commands);
    state.entries.push({
      role: "toolResult",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      text: outcome.text,
      isError: outcome.isError,
    });
  }
}

/** One model call: send the conversation and the tools, then run whatever the model asked for. */
async function advanceTurn(
  capabilities: Generation0Capabilities,
  state: TurnState,
): Promise<TurnStep> {
  const response = await callModel(
    capabilities.MODEL,
    piContextToRouteRequest({
      systemPrompt: GENERATION_0_SYSTEM_PROMPT,
      messages: transcriptToPiMessages(state.entries),
      tools: GENERATION_0_TOOLS,
    }),
  );
  if (!response.ok) {
    return { kind: "failed", problem: modelProblem(response) };
  }

  const assistant = routeResponseToPiAssistant(response);
  if (isResponseError(assistant)) {
    return { kind: "failed", problem: { code: "model-unavailable" } };
  }

  const entry = assistantEntry(assistant);
  state.entries.push(entry);
  if (entry.text !== "") {
    state.texts.push(entry.text);
  }
  if (entry.toolCalls.length === 0) {
    return { kind: "answered" };
  }

  await runToolCalls(capabilities, state, entry.toolCalls);
  return { kind: "called-tools" };
}

/**
 * Run one buffered turn: send the conversation and the tool catalogue to the model route, execute
 * the tool calls it asks for against the workspace capability, and repeat until the model answers
 * without a tool call.
 *
 * The saved document arrives with the request and leaves with the result, so the facet keeps no
 * conversation of its own and a replaced generation loses nothing.
 */
export async function runGeneration0Turn(
  capabilities: Generation0Capabilities,
  request: TurnRequest,
): Promise<TurnOutcome> {
  const saved = parseSessionDocument(request.document);
  if (saved === undefined) {
    return { ok: false, problem: { code: "invalid-session-document" } };
  }

  const state: TurnState = {
    entries: [...saved, { role: "user", text: request.prompt }],
    texts: [],
    commands: [],
  };

  for (let modelCall = 0; modelCall < MAX_MODEL_CALLS; modelCall += 1) {
    const step = await advanceTurn(capabilities, state);
    if (step.kind === "failed") {
      return { ok: false, problem: step.problem };
    }
    if (step.kind === "answered") {
      return completed(state.entries, state.texts, state.commands);
    }
  }

  return completed(state.entries, [...state.texts, MODEL_CALL_LIMIT_NOTE], state.commands);
}
