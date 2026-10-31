import type { ModelStreamEvent } from "../src/model-route.js";
import { byteChunkStream } from "./byte-stream-fixture.js";

export const rawByteStream = byteChunkStream;

const encoder = new TextEncoder();

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Test-only encoder: builds a wire payload rather than parsing untrusted input.
export function sseLine(payload: unknown): string {
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

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: every line came from the model route, which encodes exactly one ModelStreamEvent per line.
  return lines.map((line) => JSON.parse(line) as ModelStreamEvent);
}
