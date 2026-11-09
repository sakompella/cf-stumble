import type * as Schema from "effect/Schema";
import { isModelStreamEvent } from "../src/model-route-wire/events.js";
import type { ModelRouteRequest } from "../src/model-route-wire/request.js";
import type { ModelStreamInference, ModelStreamEvent } from "../src/model-route-wire/events.js";
import { workersAiTurn } from "../src/model-route-stream.js";
import { modelEventStream } from "../src/model-route-turn.js";
import { byteChunkStream } from "./byte-stream-fixture.js";

export const rawByteStream = byteChunkStream;

const encoder = new TextEncoder();

export function sseLine(payload: Schema.Json): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

export const DONE_LINE = "data: [DONE]\n\n";

export function providerStream(body: string): ReadableStream<Uint8Array> {
  return rawByteStream([encoder.encode(body)]);
}

export function providerStreamOfLines(lines: readonly string[]): ReadableStream<Uint8Array> {
  return rawByteStream(lines.map((line) => encoder.encode(line)));
}

export async function collectEvents(
  stream: ReadableStream<Uint8Array>,
): Promise<ModelStreamEvent[]> {
  const text = await new Response(stream).text();
  const lines = text.split("\n").filter((line) => line !== "");

  return lines.map((line): ModelStreamEvent => {
    const event: unknown = JSON.parse(line);

    if (!isModelStreamEvent(event)) throw new Error(`the model route wrote ${line}`);

    return event;
  });
}

export function streamModelEvents(
  ai: ModelStreamInference,
  request: ModelRouteRequest,
): ReadableStream<Uint8Array> {
  return modelEventStream(workersAiTurn(ai, request));
}
