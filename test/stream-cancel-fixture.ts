import type { ModelRouteRequest } from "../src/model-route-wire/request.js";

export const REQUEST: ModelRouteRequest = { messages: [{ role: "user", content: "hi" }] };

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
