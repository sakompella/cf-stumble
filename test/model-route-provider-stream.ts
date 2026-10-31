import type * as Schema from "effect/Schema";
import { isModelStreamEvent } from "../src/model-route-events.js";
import type { ModelStreamEvent } from "../src/model-route.js";
import { byteChunkStream } from "./byte-stream-fixture.js";

export const rawByteStream = byteChunkStream;

const encoder = new TextEncoder();

export function sseLine(payload: Schema.Json): string {
  return `data: ${JSON.stringify(payload)}\n`;
}

export const DONE_LINE = "data: [DONE]\n";

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
