import { WorkerEntrypoint } from "cloudflare:workers";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  parseRequest,
  type AssistantMessage,
  type RouteMessage,
  type RouteWire,
  type ValidationFailure,
} from "./model-route-wire/request.js";
import { modelEventStream } from "./model-route-turn.js";
import {
  STARTUP_CHECK_COMMAND,
  STARTUP_CHECK_CONTAINER_COMMAND,
  STARTUP_CHECK_ISOLATE_COMMAND,
  STARTUP_CHECK_OUTPUT,
  STARTUP_CHECK_REPLY,
  STARTUP_CHECK_RESUMED_MESSAGE,
} from "./startup-check-script.js";
import { WORKSPACE_ROOT } from "./workspace-layout.js";

const USAGE = { inputTokens: 0, outputTokens: 0, estimated: true };

type Edit = Readonly<{ oldText: string; newText: string }>;

type Call = Readonly<{
  tool: string;
  args: Readonly<Record<string, string | readonly Edit[]>>;
}>;

type Step = Readonly<{
  name: string;
  calls: (scratchFile: string) => readonly Call[];
  expected: ReadonlyArray<(output: string) => boolean>;
}>;

const bash = (args: Call["args"]): Call => ({ tool: "bash", args });

const SCRATCH_COMMAND: Step = {
  name: "scratch-command",
  calls: () => [bash({ command: STARTUP_CHECK_COMMAND })],
  expected: [(output) => output.includes(STARTUP_CHECK_OUTPUT)],
};

const FULL_SCRIPT: readonly Step[] = [
  {
    name: "parallel-tools",
    calls: () => [
      bash({ command: STARTUP_CHECK_ISOLATE_COMMAND, backend: "isolate" }),
      bash({ command: STARTUP_CHECK_CONTAINER_COMMAND, backend: "container" }),
      ...SCRATCH_COMMAND.calls(""),
    ],
    expected: [
      (output) => output.includes("startup-check-isolate"),
      (output) => /^v\d+\./mu.test(output),
      ...SCRATCH_COMMAND.expected,
    ],
  },
  {
    name: "stumble-status",
    calls: () => [bash({ command: "stumble gen status" })],
    expected: [(output) => /active generation.*epoch \d+/u.test(output)],
  },
  {
    name: "write",
    calls: (path) => [{ tool: "write", args: { path, content: "startup-check-written\n" } }],
    expected: [(output) => output.startsWith("Successfully wrote")],
  },
  {
    name: "edit",
    calls: (path) => [
      { tool: "edit", args: { path, edits: [{ oldText: "written", newText: "edited" }] } },
    ],
    expected: [(output) => output.startsWith("Successfully replaced")],
  },
  {
    name: "read",
    calls: (path) => [{ tool: "read", args: { path } }],
    expected: [(output) => output.includes("startup-check-edited")],
  },
  {
    name: "cleanup",
    calls: (path) => [bash({ command: `rm -rf ${path.slice(0, path.lastIndexOf("/"))}` })],
    expected: [() => true],
  },
];

const decodePath = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ path: Schema.String })),
);

function scratchFile(calls: readonly AssistantMessage["tool_calls"][number][]): string {
  const written = calls.find((call) => call.function.name === "write");

  const decoded = written === undefined ? Option.none() : decodePath(written.function.arguments);

  return Option.match(decoded, {
    onNone: () => `${WORKSPACE_ROOT}/.startup-check-${crypto.randomUUID()}/probe.txt`,
    onSome: ({ path }) => path,
  });
}

function reply(content: string): AssistantMessage {
  return { role: "assistant", content, tool_calls: [] };
}

function turnScript(message: string | undefined): readonly Step[] {
  return message === STARTUP_CHECK_RESUMED_MESSAGE ? FULL_SCRIPT : [SCRATCH_COMMAND];
}

export function startupCheckSteps(message: string): readonly string[] {
  return turnScript(message).map((step) => step.name);
}

function scriptedAnswer(messages: ReadonlyArray<RouteMessage>): AssistantMessage {
  const start = messages.findLastIndex((message) => message.role === "user");
  const script = turnScript(messages[start]?.content ?? undefined);
  const turn = messages.slice(start + 1);

  const calls = turn.flatMap((message) => (message.role === "assistant" ? message.tool_calls : []));

  const outputs = new Map(
    turn.flatMap((message) =>
      message.role === "tool" ? [[message.tool_call_id, message.content]] : [],
    ),
  );

  const asked = turn.filter((message) => message.role === "assistant").length;
  const previous = script[asked - 1];

  const unexpected = (previous?.expected ?? []).flatMap((expected, index) => {
    const output = outputs.get(`${previous?.name ?? ""}:${index}`) ?? "";

    return expected(output) ? [] : [output];
  })[0];

  if (unexpected !== undefined) return reply(`the tool answered: ${unexpected}`);

  const next = script[asked];

  if (next === undefined) return reply(STARTUP_CHECK_REPLY);

  return {
    role: "assistant",
    content: null,
    tool_calls: next.calls(scratchFile(calls)).map(({ tool, args }, index) => ({
      id: `${next.name}:${index}`,
      function: { name: tool, arguments: JSON.stringify(args) },
    })),
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
