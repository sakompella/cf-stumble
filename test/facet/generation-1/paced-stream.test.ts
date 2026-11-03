import { expect, test } from "vitest";
import { PacedStream } from "../../../src/facet/generation-1/paced-stream.js";

const bytes = new TextEncoder().encode("line\n");

async function settled(promise: Promise<void>): Promise<boolean> {
  let done = false;

  void promise.then(() => {
    done = true;
  });
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

  return done;
}

test("a send waits for the reader to pull, then delivers its bytes", async () => {
  const stream = new PacedStream(() => {});
  const sent = stream.send(bytes);

  expect(await settled(sent)).toBe(false);

  const reader = stream.readable.getReader();

  expect((await reader.read()).value).toEqual(bytes);
  expect(await settled(sent)).toBe(true);
});

test.each(["close", "cancel"] as const)(
  "%s settles a send that no reader pulled",
  async (ending) => {
    let cancelled = 0;

    const stream = new PacedStream(() => {
      cancelled += 1;
    });

    const sent = stream.send(bytes);

    if (ending === "close") stream.close();
    else await stream.readable.cancel();

    expect(await settled(sent)).toBe(true);
    expect(await settled(stream.send(bytes))).toBe(true);
    expect(cancelled).toBe(ending === "cancel" ? 1 : 0);
  },
);
