import * as Effect from "effect/Effect";
import { expect, test } from "vitest";
import { runAtEntryPoint, runResponseBody } from "../src/run-entry-point.js";

const RUNNERS = [
  ["runAtEntryPoint", (program: Effect.Effect<void>) => runAtEntryPoint(program)],
  [
    "runResponseBody",
    (program: Effect.Effect<void>) => runResponseBody(program, new AbortController().signal),
  ],
] as const;

test.each(RUNNERS)(
  "%s: a defect rejects with the value that was thrown, as an async function would",
  async (_name, run) => {
    const thrown = new Error("platform fault");

    await expect(run(Effect.promise(() => Promise.reject(thrown)))).rejects.toBe(thrown);
    await expect(
      run(
        Effect.sync(() => {
          throw thrown;
        }),
      ),
    ).rejects.toBe(thrown);
  },
);

test("a response body keeps streaming after the program has returned", async () => {
  const body = new TransformStream<Uint8Array, Uint8Array>();
  const response = await runAtEntryPoint(Effect.succeed(new Response(body.readable)));
  const writer = body.writable.getWriter();
  const encoder = new TextEncoder();
  const read = response.text();

  await writer.write(encoder.encode("first "));
  await writer.write(encoder.encode("second"));
  await writer.close();

  await expect(read).resolves.toBe("first second");
});

test("a body's program runs until the body is cancelled, then runs its finalizers", async () => {
  const cancelled = new AbortController();
  const finalized: string[] = [];

  const running = runResponseBody(
    Effect.never.pipe(
      Effect.ensuring(
        Effect.sync(() => {
          finalized.push("released");
        }),
      ),
    ),
    cancelled.signal,
  );

  await scheduler.wait(5);
  expect(finalized).toEqual([]);

  cancelled.abort();

  await expect(running).resolves.toBeUndefined();
  expect(finalized).toEqual(["released"]);
});
