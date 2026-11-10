import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { num, obj, oneOf, opt, str } from "@earendil-works/pi-schema";

const PREFIX = "fuzz-exec:";

const FULL_TEXT_CHARACTERS = 4_000;

const EDGE_CHARACTERS = 120;

const SPILL_AFTER_BYTES = 51_200;

const SPILL_AFTER_LINES = 2_000;

const DEFAULT_TIMEOUT_SECONDS = 120;

const encoder = new TextEncoder();

type Backend = "isolate" | "container";

type Step = Readonly<{ command: string; backend?: Backend; timeout?: number; cwd?: string }>;

type RouteMessage = Readonly<{ role: string; content?: string | null }>;

type Request = Readonly<{ messages: ReadonlyArray<RouteMessage> }>;

type Capability = Readonly<{
  runStream(request: Request): Promise<ReadableStream<Uint8Array>>;
}>;

type ShellEnv = ExecutionEnv & Readonly<{ onBackend?: (backend: Backend) => ExecutionEnv }>;

async function digest(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", encoder.encode(text));

  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function describeText(text: string) {
  return {
    bytes: encoder.encode(text).byteLength,
    lines: text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0),
    sha256: await digest(text),
    text: text.length <= FULL_TEXT_CHARACTERS ? text : null,
    head: text.slice(0, EDGE_CHARACTERS),
    tail: text.slice(-EDGE_CHARACTERS),
  };
}

function isStep(value: unknown): value is Step {
  return typeof value === "object" && value !== null && "command" in value;
}

const execTool = defineTool({
  name: "fuzz_exec",
  description: "Run one command and report stdout, stderr, the exit code and the saved output.",
  parameters: obj(
    {
      command: str({ description: "The command" }),
      backend: opt(oneOf(["isolate", "container"], { description: "Backend override" })),
      timeout: opt(num({ description: "Timeout in seconds" })),
      cwd: opt(str({ description: "Working directory" })),
    },
    { open: true },
  ),
  structuredOutputSchema: {},
  outputLimits: {},
  execute: async (args, api, context) => {
    const base: ShellEnv | undefined = api.env;

    if (base === undefined) return { output: [{ type: "text", text: "no environment" }] };

    const env = args.backend === undefined ? base : (base.onBackend?.(args.backend) ?? base);
    const out: string[] = [];
    const err: string[] = [];
    const started = Date.now();

    const result = await env.exec(
      args.command,
      {
        cwd: args.cwd ?? base.cwd,
        env: {},
        inheritEnv: true,
        timeout: args.timeout ?? DEFAULT_TIMEOUT_SECONDS,
        onOutput: (text, _context, info) => {
          (info.stream === "stderr" ? err : out).push(text);
        },
        spill: { afterBytes: SPILL_AFTER_BYTES, afterLines: SPILL_AFTER_LINES },
      },
      context,
    );

    const spillPath = result.ok ? result.value.spillPath : result.error.spillPath;
    const saved = spillPath === undefined ? undefined : await env.readTextFile(spillPath, context);

    const report = {
      ok: result.ok,
      exitCode: result.ok ? result.value.exitCode : null,
      error: result.ok ? null : result.error.code,
      ms: Date.now() - started,
      stdout: await describeText(out.join("")),
      stderr: await describeText(err.join("")),
      spill:
        spillPath === undefined
          ? null
          : {
              path: spillPath,
              readable: saved?.ok === true,
              content: saved?.ok === true ? await describeText(saved.value) : null,
            },
    };

    return { output: [{ type: "text", text: JSON.stringify(report) }] };
  },
});

export const FuzzTools = defineExtension({ name: "fuzz-exec", tools: [execTool] });

function plan(messages: ReadonlyArray<RouteMessage>): readonly Step[] | undefined {
  const start = messages.findLastIndex((message) => message.role === "user");
  const content = messages[start]?.content ?? "";

  if (!content.startsWith(PREFIX)) return undefined;

  const steps: unknown = JSON.parse(content.slice(PREFIX.length));

  return Array.isArray(steps) ? steps.filter(isStep) : [];
}

type Answer = Readonly<{
  role: "assistant";
  content: string | null;
  tool_calls: ReadonlyArray<
    Readonly<{ id: string; function: Readonly<{ name: string; arguments: string }> }>
  >;
}>;

function answerStream(message: Answer): ReadableStream<Uint8Array> {
  const usage = { inputTokens: 0, outputTokens: 0, estimated: true };
  const line = `${JSON.stringify({ type: "done", message, usage })}\n`;

  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(line));
      controller.close();
    },
  });
}

export function fuzzModel(real: Capability): Capability {
  return {
    runStream: (request) => {
      const steps = plan(request.messages);

      if (steps === undefined) return real.runStream(request);

      const start = request.messages.findLastIndex((message) => message.role === "user");
      const asked = request.messages.slice(start + 1).filter((m) => m.role === "assistant").length;
      const step = steps[asked];

      if (step === undefined) {
        return Promise.resolve(
          answerStream({ role: "assistant", content: "fuzz-exec done", tool_calls: [] }),
        );
      }

      return Promise.resolve(
        answerStream({
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: `fuzz:${asked}`,
              function: { name: "fuzz_exec", arguments: JSON.stringify(step) },
            },
          ],
        }),
      );
    },
  };
}
