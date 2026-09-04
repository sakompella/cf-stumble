// oxlint-disable anti-slop/no-unknown-parameters -- The parse boundary for a turn request. It
// arrives as an argument of an RPC method the Supervisor calls on this facet, so nothing about its
// shape is proven until these functions prove it.

import { isPlainObject, isString } from "./plain-values.js";
import type { PiAgentTurnState } from "./pi-agent-turn.js";

/** What a caller sends to start one turn. The thread arrives with it and leaves in the frames. */
export type FacetTurnRequest = Readonly<{
  prompt: string;
  state: PiAgentTurnState | null;
}>;

/**
 * Recognizes a saved Pi state by the four fields Pi's agent declares, without reading inside them.
 * Pi owns the schema of a message and of a model descriptor, so parsing those here would fork that
 * schema into this generation and break the next Pi upgrade. What this does guarantee is that a
 * caller cannot start a turn from a value Pi's `Agent` would reject outright.
 */
function parsePiAgentTurnState(value: unknown): PiAgentTurnState | undefined {
  if (!isPlainObject(value)) return undefined;
  if (!isString(value.systemPrompt) || !isString(value.thinkingLevel)) return undefined;
  if (!isPlainObject(value.model) || !Array.isArray(value.messages)) return undefined;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: the four fields Pi's agent state declares are present with the right kinds; their interiors stay Pi's to interpret.
  return value as PiAgentTurnState;
}

export function parseFacetTurnRequest(value: unknown): FacetTurnRequest | undefined {
  if (!isPlainObject(value)) return undefined;
  const { prompt, state } = value;
  if (!isString(prompt)) return undefined;
  if (state === null || state === undefined) return { prompt, state: null };
  const parsed = parsePiAgentTurnState(state);
  return parsed === undefined ? undefined : { prompt, state: parsed };
}
