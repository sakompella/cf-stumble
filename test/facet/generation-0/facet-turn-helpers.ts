import { startFacetTurn } from "../../../src/facet/generation-0/facet-turn.js";
import { WORKSPACE_ROOT } from "../../../src/workspace-layout.js";
import type {
  FacetTurnFrame,
  FacetTurnRequest,
} from "../../../src/facet/generation-0/facet-turn.js";
import type {
  Generation0Capabilities,
  ModelCapability,
} from "../../../src/facet/generation-0/index.js";
import type {
  ModelRouteRequest,
  ModelRouteResponse,
  ModelStreamEvent,
  ToolCall,
  ValidationFailure,
} from "../../../src/model-route.js";
import type { FakeProjectCapability } from "./fake-project-capability.js";

/** Tool arguments a scripted assistant message asks for. Every stock tool takes strings. */
type ScriptedToolArguments = Readonly<Record<string, string>>;

/**
 * The single-event NDJSON stream `ModelRoute.runStream` produces when a provider reports its whole
 * reply in one chunk. A scripted answer carries no usage, so a `done` event reports zero tokens,
 * marked as an estimate.
 */
export function encodeModelRouteResponseAsStream(
  response: ModelRouteResponse,
): ReadableStream<Uint8Array> {
  const event: ModelStreamEvent = response.ok
    ? {
        type: "done",
        message: response.message,
        usage: { inputTokens: 0, outputTokens: 0, estimated: true },
      }
    : { type: "error", error: response.error };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`${JSON.stringify(event)}\n`));
      controller.close();
    },
  });
}

/**
 * A model route that answers from a script. The facet's own route-backed stream function runs
 * unchanged on top of it, so these turns exercise the same request conversion a real route would
 * receive while the test still chooses every assistant message.
 *
 * `runStream` encodes each scripted answer as the single-event NDJSON stream a provider that
 * answers in one chunk would produce, so these turns exercise the real streaming seam (parsing,
 * assembly, `done`/`error` termination) rather than a second, parallel fake protocol.
 */
export class ScriptedRoute implements ModelCapability {
  readonly requests: ModelRouteRequest[] = [];
  readonly #answers: ModelRouteResponse[];

  constructor(answers: readonly ModelRouteResponse[]) {
    this.#answers = [...answers];
  }

  runStream(request: ModelRouteRequest): Promise<ReadableStream<Uint8Array> | ValidationFailure> {
    this.requests.push(request);

    return Promise.resolve(encodeModelRouteResponseAsStream(this.#answers.shift() ?? says("")));
  }
}

export function says(content: string): ModelRouteResponse {
  return { ok: true, message: { role: "assistant", content, tool_calls: [] } };
}

export function calls(
  name: string,
  args: ScriptedToolArguments,
  id = `${name}-1`,
): ModelRouteResponse {
  const toolCall: ToolCall = { id, function: { name, arguments: JSON.stringify(args) } };

  return { ok: true, message: { role: "assistant", content: null, tool_calls: [toolCall] } };
}

export const routeUnavailable: ModelRouteResponse = {
  ok: false,
  error: { code: "model-unavailable" },
};

export function capabilities(route: ModelCapability): Generation0Capabilities {
  return { MODEL: route };
}

export const OPENING_TURN: FacetTurnRequest = { prompt: "go", messages: [] };

export function turnStream(
  route: ModelCapability,
  received: FakeProjectCapability,
  request: FacetTurnRequest = OPENING_TURN,
  workingDirectory: string = WORKSPACE_ROOT,
): ReadableStream<Uint8Array> {
  return startFacetTurn(capabilities(route), received, request, workingDirectory);
}

export async function readFrames(stream: ReadableStream<Uint8Array>): Promise<FacetTurnFrame[]> {
  const text = await new Response(stream).text();
  const lines = text.split("\n").filter((line) => line !== "");

  // SAFETY: every line came from startFacetTurn, which encodes exactly one FacetTurnFrame per line.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return lines.map((line) => JSON.parse(line) as FacetTurnFrame);
}

export function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}
