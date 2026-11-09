import * as Schema from "effect/Schema";
import type { ExecEvent, ProjectFailure } from "../../../src/workspace/project/protocol.js";
import type { ProjectRpcTarget } from "../../../src/workspace/project/target.js";

export type { ExecEvent };

const ExecFrame = Schema.Union([
  Schema.Struct({
    kind: Schema.Literals(["stdout", "stderr"]),
    seq: Schema.Number,
    data: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("terminal"),
    seq: Schema.Number,
    outcome: Schema.Literal("exited"),
    exitCode: Schema.Number,
    fullOutputPaths: Schema.optional(Schema.Array(Schema.String)),
  }),
  Schema.Struct({
    kind: Schema.Literal("terminal"),
    seq: Schema.Number,
    outcome: Schema.Literals(["killed", "timed-out"]),
  }),
  Schema.Struct({
    kind: Schema.Literal("terminal"),
    seq: Schema.Number,
    outcome: Schema.Literal("failed"),
    error: Schema.Struct({ code: Schema.Literals(["backend-unavailable", "container-restarted"]) }),
  }),
]);

const decodeFrame = Schema.decodeSync(Schema.fromJsonString(ExecFrame));

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
            controller.enqueue(decodeFrame(frame));

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
    endTurn: () => target.endTurn(),
  };
}
