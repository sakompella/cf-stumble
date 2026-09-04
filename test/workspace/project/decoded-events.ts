// oxlint-disable anti-slop/no-object-parameters, anti-slop/no-unknown-returns, anti-slop/no-unknown-parameters

import type { ExecEvent, ProjectFailure } from "../../../src/workspace/project/protocol.js";
import type { ProjectRpcTarget } from "../../../src/workspace/project/target.js";

function property(value: object, key: string): unknown {
  return Object.getOwnPropertyDescriptor(value, key)?.value;
}

function isExecEvent(value: unknown): value is ExecEvent {
  if (typeof value !== "object" || value === null) return false;
  const kind = property(value, "kind");
  const outcome = property(value, "outcome");
  if (typeof kind !== "string" || typeof property(value, "seq") !== "number") return false;
  if (kind === "stdout" || kind === "stderr") return typeof property(value, "data") === "string";
  if (kind !== "terminal" || typeof outcome !== "string") return false;
  return (
    outcome === "killed" ||
    outcome === "timed-out" ||
    (outcome === "exited" && typeof property(value, "exitCode") === "number") ||
    (outcome === "failed" && typeof property(value, "error") === "object")
  );
}

function decodeEvents(events: ReadableStream<Uint8Array>): ReadableStream<ExecEvent> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const decoder = new TextDecoder();
  let buffer = "";

  return new ReadableStream(
    {
      async pull(controller) {
        reader ??= events.getReader();
        for (;;) {
          const newline = buffer.indexOf("\n");
          if (newline >= 0) {
            const frame = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            const event: unknown = JSON.parse(frame);
            if (!isExecEvent(event)) throw new Error("invalid exec frame");
            controller.enqueue(event);
            return;
          }
          const next = await reader.read();
          if (next.done) {
            buffer += decoder.decode();
            controller.close();
            return;
          }
          buffer += decoder.decode(next.value, { stream: true });
        }
      },
      cancel: () => reader?.cancel() ?? events.cancel(),
    },
    { highWaterMark: 0 },
  );
}

type DecodedStart =
  | ProjectFailure
  | { ok: true; value: { operationId: string; events: ReadableStream<ExecEvent> } };

export function withDecodedEvents(target: ProjectRpcTarget) {
  return {
    async startExec(...input: Parameters<ProjectRpcTarget["startExec"]>): Promise<DecodedStart> {
      const started = await target.startExec(...input);
      return started.ok
        ? { ok: true, value: { ...started.value, events: decodeEvents(started.value.events) } }
        : started;
    },
    kill: (...operationId: Parameters<ProjectRpcTarget["kill"]>) => target.kill(...operationId),
  };
}
