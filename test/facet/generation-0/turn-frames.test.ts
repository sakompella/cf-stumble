import { expect, test } from "vitest";
import { startFacetTurn } from "../../../src/facet/generation-0/index.js";
import { FakeProjectCapability } from "./fake-project-capability.js";
import {
  capabilities,
  readFrames,
  routeUnavailable,
  ScriptedRoute,
  turnStream,
} from "./facet-turn-helpers.js";
import type { ModelCapability } from "../../../src/facet/generation-0/index.js";
import type { FacetTurnFrame } from "../../../src/facet/generation-0/index.js";
import type {
  ModelRouteRequest,
  ModelStreamEvent,
  ValidationFailure,
} from "../../../src/model-route.js";

const TERMINAL = new Set(["completed", "failed", "rejected"]);

function terminalFrames(frames: readonly FacetTurnFrame[]): readonly FacetTurnFrame[] {
  return frames.filter((frame) => TERMINAL.has(frame.kind));
}

/**
 * A route that answers one reply as several NDJSON deltas, which is what a provider streaming
 * tokens produces. `ScriptedRoute` encodes each answer as one `done` event, so it cannot show
 * whether text reaches the frames before the reply is finished; this can.
 */
class DeltaRoute implements ModelCapability {
  readonly requests: ModelRouteRequest[] = [];
  readonly #chunks: readonly string[];

  constructor(chunks: readonly string[]) {
    this.#chunks = chunks;
  }

  run(): Promise<ValidationFailure> {
    return Promise.resolve({ ok: false, error: { code: "invalid-request", reason: "unused" } });
  }

  runStream(request: ModelRouteRequest): Promise<ReadableStream<Uint8Array>> {
    this.requests.push(request);
    const text = this.#chunks.join("");
    const events: ModelStreamEvent[] = [
      ...this.#chunks.map((delta): ModelStreamEvent => ({ type: "text-delta", delta })),
      {
        type: "done",
        message: { role: "assistant", content: text, tool_calls: [] },
        usage: { inputTokens: 12, outputTokens: 34, estimated: false },
      },
    ];
    const encoder = new TextEncoder();
    return Promise.resolve(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const event of events) {
            controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
          }
          controller.close();
        },
      }),
    );
  }
}

test("text arrives as one frame per delta, and the reply is not repeated at the end", async () => {
  const route = new DeltaRoute(["The check ", "passed ", "cleanly."]);

  const frames = await readFrames(turnStream(route, FakeProjectCapability.create()));

  expect(frames.map((frame) => frame.kind)).toEqual(["text", "text", "text", "completed"]);
  expect(frames.slice(0, 3).map((frame) => (frame.kind === "text" ? frame.text : ""))).toEqual([
    "The check ",
    "passed ",
    "cleanly.",
  ]);
});

test("a whole reply from a route that sends no deltas is still published exactly once", async () => {
  const route = new ScriptedRoute([
    { ok: true, message: { role: "assistant", content: "All done.", tool_calls: [] } },
  ]);

  const frames = await readFrames(turnStream(route, FakeProjectCapability.create()));

  expect(frames.map((frame) => frame.kind)).toEqual(["text", "completed"]);
  expect(frames[0]).toEqual({ kind: "text", text: "All done." });
});

test("a successful turn ends in exactly one completed frame carrying the next turn's state", async () => {
  const route = new ScriptedRoute([
    { ok: true, message: { role: "assistant", content: "Saved.", tool_calls: [] } },
  ]);

  const frames = await readFrames(turnStream(route, FakeProjectCapability.create()));
  const terminal = terminalFrames(frames);

  const completed = terminal[0];
  expect(terminal.length).toBe(1);
  expect(completed?.kind).toBe("completed");
  if (completed?.kind !== "completed") return;
  expect(
    completed.state.messages.map((message) => message.role),
    "the completed turn hands its conversation on",
  ).toEqual(["user", "assistant"]);
});

test("a failed turn keeps the conversation, and a rejected one has none to keep", async () => {
  const failed = terminalFrames(
    await readFrames(
      turnStream(new ScriptedRoute([routeUnavailable]), FakeProjectCapability.create()),
    ),
  );
  const rejected = terminalFrames(
    await readFrames(
      startFacetTurn(
        capabilities(new ScriptedRoute([])),
        FakeProjectCapability.create(),
        { prompt: 7 },
        "/workspace",
      ),
    ),
  );

  const failure = failed[0];
  expect(failed.length).toBe(1);
  expect(failure).toMatchObject({ kind: "failed", code: "model-error" });
  if (failure?.kind !== "failed") return;
  expect(
    failure.state.messages.map((message) => message.role),
    "a failed turn still produced conversation the thread must keep",
  ).toEqual(["user", "assistant"]);

  expect(rejected).toEqual([{ kind: "rejected", code: "invalid-turn-request" }]);
});
