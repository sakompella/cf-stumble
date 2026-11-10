type ToolCall = Readonly<{
  id: string;
  function: Readonly<{ name: string; arguments: string }>;
}>;

type Message = Readonly<{
  role: string;
  content?: string | null;
  tool_calls?: readonly ToolCall[];
}>;

type Step = Readonly<{ tool: string; args: object }>;

type Capability<Request extends Readonly<{ messages: readonly Message[] }>, Reply> = Readonly<{
  runStream(request: Request): Promise<Reply>;
}>;

const STEPS_PREFIX = "fuzz-steps ";

const RESULTS_PREFIX = "fuzz-results ";

const USAGE = { inputTokens: 0, outputTokens: 0, estimated: true };

const encoder = new TextEncoder();

function isStep(entry: unknown): entry is Step {
  return (
    typeof entry === "object" &&
    entry !== null &&
    "tool" in entry &&
    typeof entry.tool === "string" &&
    "args" in entry &&
    typeof entry.args === "object" &&
    entry.args !== null
  );
}

function stepsOf(text: string): readonly Step[] {
  const parsed: unknown = JSON.parse(text);

  return Array.isArray(parsed) ? parsed.filter(isStep) : [];
}

function answer(messages: readonly Message[]): Message | undefined {
  const start = messages.findLastIndex((message) => message.role === "user");
  const content = messages[start]?.content ?? "";

  if (!content.startsWith(STEPS_PREFIX)) return undefined;

  const steps = stepsOf(content.slice(STEPS_PREFIX.length));
  const turn = messages.slice(start + 1);
  const asked = turn.filter((message) => message.role === "assistant").length;
  const step = steps[asked];

  if (step === undefined) {
    const outputs = turn.flatMap((message) => (message.role === "tool" ? [message.content] : []));

    return { role: "assistant", content: RESULTS_PREFIX + JSON.stringify(outputs), tool_calls: [] };
  }

  const call = {
    id: `fuzz-${asked}`,
    function: { name: step.tool, arguments: JSON.stringify(step.args) },
  };

  return { role: "assistant", content: null, tool_calls: [call] };
}

function stream(message: Message): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode(`${JSON.stringify({ type: "done", message, usage: USAGE })}\n`),
      );
      controller.close();
    },
  });
}

export function scriptedModel<Request extends Readonly<{ messages: readonly Message[] }>, Reply>(
  base: Capability<Request, Reply>,
): Capability<Request, Reply | ReadableStream<Uint8Array>> {
  return {
    runStream(request) {
      const message = answer(request.messages);

      return message === undefined ? base.runStream(request) : Promise.resolve(stream(message));
    },
  };
}
