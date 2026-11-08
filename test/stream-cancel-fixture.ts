import type { ModelRouteRequest } from "../src/model-route-request.js";

export const REQUEST: ModelRouteRequest = { messages: [{ role: "user", content: "hi" }] };

export const PROMPTLY_MS = 5_000;

export async function until(condition: () => boolean): Promise<number> {
  const started = Date.now();

  while (!condition()) {
    if (Date.now() - started > PROMPTLY_MS) return Number.POSITIVE_INFINITY;

    await scheduler.wait(20);
  }

  return Date.now() - started;
}

export async function readFirstEvent(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<void> {
  const decoder = new TextDecoder();
  let read = "";

  while (!read.includes("text-delta")) {
    const chunk = await reader.read();

    if (chunk.done) throw new Error(`the model stream ended before its first event: ${read}`);

    read += decoder.decode(chunk.value, { stream: true });
  }
}
