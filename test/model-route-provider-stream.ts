/**
 * Test-only construction of one provider byte stream and decoding of the model route's own NDJSON
 * event stream. Shared by the `streamModelEvents` tests and the `ModelRoute.runStream` entrypoint
 * tests so both drive the route from the same wire bytes.
 *
 * Nothing here imports a production constant it is meant to pin: every model id, payload field
 * and event shape a test asserts is written out literally in that test.
 */

import type { ModelStreamEvent } from "../src/model-route.js";

/** A provider stream built from raw byte chunks, so a test controls exactly how bytes split
 * across `ReadableStream` reads — including splitting a multi-byte UTF-8 character in half. */
export function rawByteStream(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[i];
      if (chunk === undefined) {
        controller.close();
        return;
      }
      controller.enqueue(chunk);
      i += 1;
    },
  });
}

const encoder = new TextEncoder();

/** One SSE `data:` line carrying a JSON payload, as the classic Workers AI streaming shape sends. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Test-only encoder: builds a wire payload rather than parsing untrusted input.
export function sseLine(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n`;
}

/** The terminal marker a well-formed provider stream ends with. */
export const DONE_LINE = "data: [DONE]\n";

/** One provider stream whose whole SSE body arrives as a single byte chunk. */
export function providerStream(body: string): ReadableStream<Uint8Array> {
  return rawByteStream([encoder.encode(body)]);
}

/** One provider stream whose SSE body arrives one line per byte chunk. */
export function providerStreamOfLines(lines: readonly string[]): ReadableStream<Uint8Array> {
  return rawByteStream(lines.map((line) => encoder.encode(line)));
}

export async function collectEvents(
  stream: ReadableStream<Uint8Array>,
): Promise<ModelStreamEvent[]> {
  const text = await new Response(stream).text();
  const lines = text.split("\n").filter((line) => line !== "");
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion, anti-slop/require-safety-comment-for-type-assertion -- SAFETY: every line came from the model route, which encodes exactly one ModelStreamEvent per line.
  return lines.map((line) => JSON.parse(line) as ModelStreamEvent);
}
