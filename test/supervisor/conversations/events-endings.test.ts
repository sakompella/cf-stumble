import { expect, test, vi } from "vitest";
import { EventsEndings } from "../../../src/supervisor/conversations/events-endings.js";
import { textLines } from "../../log-capture.js";

async function drain(stream: ReadableStream<Uint8Array>): Promise<number> {
  const reader = stream.getReader();
  let chunks = 0;

  for (;;) {
    const { done } = await reader.read();

    if (done) return chunks;
    chunks += 1;
  }
}

test("an events stream that fails ends the relay cleanly and logs the failure once", async () => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});

  const failing = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1]));
      controller.error(new Error("the facet's event stream broke"));
    },
  });

  await expect(drain(new EventsEndings().relayed("project", failing))).resolves.toBeLessThanOrEqual(
    1,
  );
  expect(textLines(errors)).toEqual([
    expect.stringContaining("the facet's event stream failed: the facet's event stream broke"),
  ]);
});
