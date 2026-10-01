import { expect, test, vi } from "vitest";
import { type SpanTracer, withRouteSpan } from "../../src/routes/route-span.js";

/** Tracing is diagnostics: it may fail in any way and the request must not notice. */

const attributes = { requestId: "id-1", route: "/api/projects" } as const;

const ignoreAttributes = (): void => undefined;

function tracer(enterSpan: SpanTracer["enterSpan"]): SpanTracer {
  return { enterSpan };
}

test("the span carries the request id and the route pattern, and the result passes through", () => {
  const setAttributes = vi.fn<(attributes: Record<string, string>) => void>();
  const names: string[] = [];

  const result = withRouteSpan(
    attributes,
    () => "done",
    tracer((name, callback) => {
      names.push(name);

      return callback({ setAttributes });
    }),
  );

  expect(result).toBe("done");
  expect(names).toEqual(["owner-api.route"]);
  expect(setAttributes).toHaveBeenCalledExactlyOnceWith({
    "request.id": "id-1",
    route: "/api/projects",
  });
});

test("a tracer that throws before the callback leaves the work to run once, unspanned", () => {
  const work = vi.fn(() => 7);

  const result = withRouteSpan(
    attributes,
    work,
    tracer(() => {
      throw new Error("no tracing");
    }),
  );

  expect(result).toBe(7);
  expect(work).toHaveBeenCalledTimes(1);
});

test("an absent tracing API leaves the work to run once", () => {
  const work = vi.fn(() => 8);
  // SAFETY: the empty object stands for a runtime whose `tracing` lacks `enterSpan`.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Simulates a runtime without the API.
  const absent = {} as SpanTracer;

  expect(withRouteSpan(attributes, work, absent)).toBe(8);
  expect(work).toHaveBeenCalledTimes(1);
});

test("a tracer that throws after the callback returns the result the work produced", () => {
  const work = vi.fn(() => 9);

  const result = withRouteSpan(
    attributes,
    work,
    tracer((_name, callback) => {
      callback({ setAttributes: ignoreAttributes });

      throw new Error("span end failed");
    }),
  );

  expect(result).toBe(9);
  expect(work).toHaveBeenCalledTimes(1);
});

test("an error from the work passes through unchanged, even if the tracer then throws another", () => {
  const failure = new Error("work failed");

  expect(() =>
    withRouteSpan(
      attributes,
      () => {
        throw failure;
      },
      tracer((_name, callback) => {
        callback({ setAttributes: ignoreAttributes });

        throw new Error("span end failed");
      }),
    ),
  ).toThrow(failure);
});

test("a span that rejects attributes still runs the work once", () => {
  const work = vi.fn(() => 10);

  const result = withRouteSpan(
    attributes,
    work,
    tracer((_name, callback) =>
      callback({
        setAttributes: () => {
          throw new Error("bad attribute");
        },
      }),
    ),
  );

  expect(result).toBe(10);
  expect(work).toHaveBeenCalledTimes(1);
});

test("the runtime tracer runs async work once and keeps its result", async () => {
  const work = vi.fn(() => Promise.resolve("async"));

  await expect(withRouteSpan(attributes, work)).resolves.toBe("async");
  expect(work).toHaveBeenCalledTimes(1);
});

test("the runtime tracer passes an async rejection through", async () => {
  const failure = new Error("async failure");

  await expect(withRouteSpan(attributes, () => Promise.reject(failure))).rejects.toBe(failure);
});
