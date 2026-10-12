import { env } from "cloudflare:workers";
import { afterEach, expect, test, vi } from "vitest";
import worker from "../src/worker.js";
import { deriveSupervisorName } from "../src/access/index.js";
import {
  accessAudience,
  accessIssuer,
  accessOwnerSubject,
  signAccessToken,
  signingKey,
  type SigningKey,
} from "./access-tokens.js";
import { sampleProjectOne } from "./project-fixtures.js";

/**
 * A streamed body outlives the Worker program that returned its headers (ADR-0037). The Worker
 * must hand the body on as it arrives, and a client that stops reading must reach the stream's
 * source, for a turn and for a relayed generation response alike.
 */

const ORIGIN = "https://cf-stumble.test";

const encoder = new TextEncoder();

afterEach(() => {
  vi.restoreAllMocks();
});

function workerEnvironment(key: SigningKey) {
  return {
    ...env,
    CF_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
    CF_ACCESS_AUD: accessAudience,
    CF_ACCESS_PUBLIC_KEYS: JSON.stringify({ keys: [key.publicJwk] }),
    CF_ACCESS_OWNER_SUB: accessOwnerSubject,
  };
}

function ownerToken(key: SigningKey): Promise<string> {
  return signAccessToken(key, {
    iss: accessIssuer,
    aud: [accessAudience],
    exp: Math.floor(Date.now() / 1000) + 600,
    sub: accessOwnerSubject,
  });
}

type HeldStream = Readonly<{ stream: ReadableStream<Uint8Array>; cancelled: Promise<void> }>;

/** A stream that sends one chunk and stays open until it is cancelled. */
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

async function ownersSupervisor() {
  const name = await deriveSupervisorName({
    identity: accessOwnerSubject,
    audience: accessAudience,
  });

  const supervisor = env.SUPERVISOR.getByName(name);
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

test("a turn's frames reach the client while the turn runs, and a cancel reaches the turn", async () => {
  const key = await signingKey("worker-turn-stream");
  const token = await ownerToken(key);
  const supervisor = await ownersSupervisor();
  const frames = heldStream('{"kind":"text","text":"working"}\n');

  // An RPC result is disposable; a result made in this isolate has nothing to release.
  vi.spyOn(supervisor, "runProjectTurn").mockResolvedValue({
    ok: true,
    frames: frames.stream,
    [Symbol.dispose]: () => {},
  });

  const response = await worker.fetch(
    new Request(`${ORIGIN}/api/projects/${sampleProjectOne.id}/turn`, {
      method: "POST",
      headers: { "cf-access-jwt-assertion": token, origin: ORIGIN },
      body: JSON.stringify({ prompt: "hello" }),
    }),
    workerEnvironment(key),
  );

  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("content-type")).toBe("application/x-ndjson; charset=utf-8");
  await expect(firstChunkThenCancel(response)).resolves.toBe('{"kind":"text","text":"working"}\n');
  await expect(frames.cancelled).resolves.toBeUndefined();
});

test("a relayed generation response streams through, and a cancel reaches the generation", async () => {
  const key = await signingKey("worker-relay-stream");
  const token = await ownerToken(key);
  const supervisor = await ownersSupervisor();
  const body = heldStream("first part");

  vi.spyOn(supervisor, "fetch").mockResolvedValue(new Response(body.stream));

  const response = await worker.fetch(
    new Request(`${ORIGIN}/generation/page`, { headers: { "cf-access-jwt-assertion": token } }),
    workerEnvironment(key),
  );

  expect(response.status).toBe(200);
  await expect(firstChunkThenCancel(response)).resolves.toBe("first part");
  await expect(body.cancelled).resolves.toBeUndefined();
});
