import * as Effect from "effect/Effect";
import { expect, test } from "vitest";
import { runAtEntryPoint, runResponseBody } from "../src/run-entry-point.js";

/**
 * The one place a native entry point interprets an Effect program. It has to behave like the
 * `async` function it replaces: the same value, the same thrown error, and a response body that
 * keeps streaming after the program has returned its headers (ADR-0037).
 */

test("a program's value is the entry point's value", async () => {
  await expect(runAtEntryPoint(Effect.succeed(7))).resolves.toBe(7);
});

test("a defect rejects with the value that was thrown, as an async function would", async () => {
  const thrown = new Error("platform fault");

  await expect(runAtEntryPoint(Effect.promise(() => Promise.reject(thrown)))).rejects.toBe(thrown);
  await expect(
    runAtEntryPoint(
      Effect.sync(() => {
        throw thrown;
      }),
    ),
  ).rejects.toBe(thrown);
});

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

test("a body's program that dies rejects with the value that was thrown", async () => {
  const thrown = new Error("stream reader unavailable");

  await expect(
    runResponseBody(
      Effect.sync(() => {
        throw thrown;
      }),
      new AbortController().signal,
    ),
  ).rejects.toBe(thrown);
});
