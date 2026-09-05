// oxlint-disable anti-slop/no-unknown-parameters -- The parse boundary for a turn request. It
// arrives as an argument of an RPC method the Supervisor calls on this facet, so nothing about its
// shape is proven until these functions prove it.

import { isPlainObject, isString } from "./plain-values.js";
import type { AgentMessage } from "@cf-stumble/pi";

/**
 * What the host sends to start one turn: the prompt, and the conversation so far.
 *
 * The conversation is all the host has and all it may send. The system prompt, the model, and the
 * thinking level are this generation's own: the prompt is rebuilt from the workspace's
 * instructions on every turn, and the model is the route this facet was given. A request that
 * carried them would let a caller choose a model, replace this generation's instructions, or hand
 * the turn a history the host never saved, which is exactly what the host's saved thread is for.
 */
export type FacetTurnRequest = Readonly<{
  prompt: string;
  messages: readonly AgentMessage[];
}>;

/**
 * Recognize a conversation without reading inside its messages. Pi owns the schema of a message,
 * so parsing one here would fork that schema into this generation and break the next Pi upgrade;
 * the host proved every message against its own stored-field rules before it saved them
 * (`supervisor/threads/messages.ts`). An absent conversation is a first turn, not a fault.
 */
function parseTurnMessages(value: unknown): readonly AgentMessage[] | undefined {
  if (value === undefined || value === null) {
    return [];
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: the value is a list, which is everything this side may claim about a conversation Pi's `Agent` will interpret.
  return Array.isArray(value) ? (value as readonly AgentMessage[]) : undefined;
}

export function parseFacetTurnRequest(value: unknown): FacetTurnRequest | undefined {
  if (!isPlainObject(value)) return undefined;
  const { prompt, messages } = value;
  if (!isString(prompt)) return undefined;
  const conversation = parseTurnMessages(messages);
  return conversation === undefined ? undefined : { prompt, messages: conversation };
}
