// oxlint-disable anti-slop/no-unknown-parameters -- The parse boundary for a turn request. It
// arrives as an argument of an RPC method the Supervisor calls on this facet, so nothing about its
// shape is proven until these functions prove it.

import { isRecord } from "../../untrusted.js";
import type { AgentMessage } from "@cf-stumble/pi";

/**
 * The host sends only the prompt and conversation. The system prompt and model are this
 * generation's own; accepting them would let a caller choose a model or replace instructions.
 */
export type FacetTurnRequest = Readonly<{
  prompt: string;
  messages: readonly AgentMessage[];
}>;

/**
 * Pi owns the message schema, so messages are not parsed here; the host validated them before
 * saving. An absent conversation is a first turn.
 */
function parseTurnMessages(value: unknown): readonly AgentMessage[] | undefined {
  if (value === undefined || value === null) {
    return [];
  }

  // SAFETY: the value is a list, which is everything this side may claim about a conversation Pi's `Agent` will interpret.
  return Array.isArray(value) ? (value as readonly AgentMessage[]) : undefined;
}

export function parseFacetTurnRequest(value: unknown): FacetTurnRequest | undefined {
  if (!isRecord(value)) return undefined;
  const { prompt, messages } = value;

  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Boundary: the prompt arrives over RPC.
  if (typeof prompt !== "string") return undefined;
  const conversation = parseTurnMessages(messages);

  return conversation === undefined ? undefined : { prompt, messages: conversation };
}
