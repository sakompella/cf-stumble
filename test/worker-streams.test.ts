import { env } from "cloudflare:workers";
import { afterEach, expect, test, vi } from "vitest";
import worker from "../src/worker.js";
import { sampleProjectOne } from "./project-fixtures.js";

const ORIGIN = "https://cf-stumble.test";

const encoder = new TextEncoder();

afterEach(() => {
  vi.restoreAllMocks();
});

type HeldStream = Readonly<{ stream: ReadableStream<Uint8Array>; cancelled: Promise<void> }>;

function heldStream(first: string): HeldStream {
  let markCancelled: (() => void) | undefined;

  const cancelled = new Promise<void>((resolve) => {
    markCancelled = resolve;
  });

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(first));
    },
    cancel() {
      markCancelled?.();
    },
  });

  const held: HeldStream = { stream, cancelled };

  return held;
}

function ownersSupervisor() {
  const supervisor = env.SUPERVISOR.getByName("owner");
  vi.spyOn(env.SUPERVISOR, "getByName").mockReturnValue(supervisor);

  return supervisor;
}

async function firstChunkThenCancel(response: Response): Promise<string> {
  const reader = response.body?.getReader();

  if (reader === undefined) throw new Error("the response has no body");

  const first: ReadableStreamReadResult<Uint8Array> = await reader.read();
  await reader.cancel();

  return new TextDecoder().decode(first.value);
}

test("a conversation's events reach the client while they commit, and a cancel reaches the watch", async () => {
  const supervisor = ownersSupervisor();
  const events = heldStream('{"type":"snapshot"}\n');

  vi.spyOn(supervisor, "projectEvents").mockResolvedValue({
    ok: true,
    events: events.stream,
    [Symbol.dispose]: () => {},
  });

  const response = await worker.fetch(
    new Request(`${ORIGIN}/api/projects/${sampleProjectOne.id}/events`),
    env,
  );

  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("content-type")).toBe("application/x-ndjson; charset=utf-8");
  await expect(firstChunkThenCancel(response)).resolves.toBe('{"type":"snapshot"}\n');
  await expect(events.cancelled).resolves.toBeUndefined();
});
