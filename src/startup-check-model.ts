import { WorkerEntrypoint } from "cloudflare:workers";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import {
  parseRequest,
  type AssistantMessage,
  type RouteMessage,
  type RouteWire,
  type ValidationFailure,
} from "./model-route-request.js";
import { modelEventStream } from "./model-route-turn.js";
import {
  STARTUP_CHECK_COMMAND,
  STARTUP_CHECK_OUTPUT,
  STARTUP_CHECK_REPLY,
} from "./startup-check-script.js";

const USAGE = { inputTokens: 0, outputTokens: 0, estimated: true };

function scriptedAnswer(messages: ReadonlyArray<RouteMessage>): AssistantMessage {
  const last = messages.at(-1);

  if (last?.role !== "tool") {
    const command = JSON.stringify({ command: STARTUP_CHECK_COMMAND });

    return {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "startup-check", function: { name: "bash", arguments: command } }],
    };
  }

  const ran = last.content.includes(STARTUP_CHECK_OUTPUT);

  return {
    role: "assistant",
    content: ran ? STARTUP_CHECK_REPLY : `the workspace command answered: ${last.content}`,
    tool_calls: [],
  };
}

export class StartupCheckModel extends WorkerEntrypoint {
  runStream(request: RouteWire): ReadableStream<Uint8Array> | ValidationFailure {
    const parsed = parseRequest(request);

    if (Result.isFailure(parsed)) return parsed.failure;
    const message = scriptedAnswer(parsed.success.messages);

    return modelEventStream(() => Effect.succeed({ message, usage: USAGE }));
  }
}
