import type { Api, AssistantMessage, AssistantMessageEventStream, Model } from "@cf-stumble/pi";
import type { ModelUsage, ToolCallDelta } from "../../model-route.js";

/**
 * The model descriptor Pi's `Agent` needs in its state. Every field the host actually decides —
 * which model, which reasoning effort, which endpoint, which credential — lives behind the model
 * route in the immutable `src/model-route.ts`, so nothing here selects anything. This describes
 * the route, not a model, which is why its costs and its context window are zero: Generation 0 has
 * no way to learn the real values and must not invent them.
 *
 * The two numbers are not zero, and that is deployed evidence rather than taste. With a zero
 * window and a zero output budget, every deployed turn saved an assistant message with empty
 * content while the route itself streamed the text: Pi sizes a response against these numbers, and
 * zero leaves no room for one. They mirror what the host route asks for in `model-route.ts`, which
 * is the only place that selects a model, so this describes the route rather than choosing
 * anything.
 */
export const ROUTE_MODEL = {
  id: "host-model-route",
  name: "Host model route",
  api: "workers-ai",
  provider: "cloudflare-workers-ai",
  baseUrl: "",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4096,
} satisfies Model<Api>;

const ZERO_USAGE: AssistantMessage["usage"] = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/**
 * Build the `usage` field Pi's `AssistantMessage` requires from what the model route reported.
 * Cache fields stay zero because this generation never attempts prompt caching, and `estimated`
 * on the route's usage tells us whether `inputTokens`/`outputTokens` are a real provider count or
 * this route's own conservative guess — either way they are never asserted as a silent zero.
 */
export function toPiUsage(usage: ModelUsage): AssistantMessage["usage"] {
  return {
    input: usage.inputTokens,
    output: usage.outputTokens,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: usage.inputTokens + usage.outputTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

export function assistantShell(
  stopReason: AssistantMessage["stopReason"],
  content: AssistantMessage["content"] = [],
  usage: AssistantMessage["usage"] = ZERO_USAGE,
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: ROUTE_MODEL.api,
    provider: ROUTE_MODEL.provider,
    model: ROUTE_MODEL.id,
    usage,
    stopReason,
    timestamp: Date.now(),
  };
}

/**
 * Best-effort parse of one accumulated tool call's argument text, mirroring the model route's own
 * recovery rule: invalid or partial JSON becomes an empty object rather than a thrown error,
 * because "no arguments yet" is honest mid-stream and a final malformed payload is the model's
 * fault, not a reason to crash the turn.
 */
// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- Boundary: mirrors Pi's own ToolCall.arguments, an open object from the model.
function parseToolArgs(text: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text);

    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Boundary: best-effort parse of accumulated tool call argument text.
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion, anti-slop/no-unsafe-dictionary-type -- SAFETY: typeof + null + array guard confirmed a plain object.
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through to the empty-object recovery below
  }

  return {};
}

type OpenTextBlock = Readonly<{ kind: "text"; contentIndex: number; text: string }>;

type OpenToolBlock = Readonly<{
  kind: "toolCall";
  contentIndex: number;
  toolIndex: number;
  id: string;
  name: string;
  args: string;
}>;

type OpenBlock = OpenTextBlock | OpenToolBlock;

/**
 * Tracks the content blocks one streamed turn has opened so far, in the order this route saw them
 * arrive, and turns each `ModelStreamEvent` into the Pi `AssistantMessageEvent`(s) it implies.
 * Every push carries a full `partial` snapshot because that is what `AssistantMessageEvent`
 * requires and what the agent loop replaces its working message with on each update.
 */
export class TurnAssembler {
  private blocks: OpenBlock[] = [];
  private toolIndexToBlock = new Map<number, number>();
  private started = false;

  private snapshot(stopReason: AssistantMessage["stopReason"] = "pending"): AssistantMessage {
    const content: AssistantMessage["content"] = this.blocks.map((block) =>
      block.kind === "text"
        ? { type: "text", text: block.text }
        : {
            type: "toolCall",
            id: block.id,
            name: block.name,
            arguments: parseToolArgs(block.args),
          },
    );

    return assistantShell(stopReason, content);
  }

  private ensureStarted(stream: AssistantMessageEventStream): void {
    if (this.started) return;
    this.started = true;
    stream.push({ type: "start", partial: this.snapshot() });
  }

  private openText(stream: AssistantMessageEventStream): OpenTextBlock {
    const last = this.blocks.at(-1);

    if (last !== undefined && last.kind === "text") return last;
    const contentIndex = this.blocks.length;
    const block: OpenTextBlock = { kind: "text", contentIndex, text: "" };
    this.blocks.push(block);
    stream.push({ type: "text_start", contentIndex, partial: this.snapshot() });

    return block;
  }

  private openTool(delta: ToolCallDelta, stream: AssistantMessageEventStream): OpenToolBlock {
    const existingAt = this.toolIndexToBlock.get(delta.index);
    const existing = existingAt === undefined ? undefined : this.blocks[existingAt];

    if (existing !== undefined && existing.kind === "toolCall") return existing;
    const contentIndex = this.blocks.length;

    const block: OpenToolBlock = {
      kind: "toolCall",
      contentIndex,
      toolIndex: delta.index,
      id: delta.id ?? "",
      name: delta.name ?? "",
      args: "",
    };

    this.blocks.push(block);
    this.toolIndexToBlock.set(delta.index, contentIndex);
    stream.push({ type: "toolcall_start", contentIndex, partial: this.snapshot() });

    return block;
  }

  textDelta(delta: string, stream: AssistantMessageEventStream): void {
    this.ensureStarted(stream);
    const block = this.openText(stream);
    this.blocks[block.contentIndex] = { ...block, text: block.text + delta };
    stream.push({
      type: "text_delta",
      contentIndex: block.contentIndex,
      delta,
      partial: this.snapshot(),
    });
  }

  toolCallDelta(delta: ToolCallDelta, stream: AssistantMessageEventStream): void {
    this.ensureStarted(stream);
    const block = this.openTool(delta, stream);
    this.blocks[block.contentIndex] = {
      ...block,
      id: delta.id ?? block.id,
      name: delta.name ?? block.name,
      args: block.args + (delta.argumentsDelta ?? ""),
    };

    if (delta.argumentsDelta === undefined || delta.argumentsDelta === "") return;
    stream.push({
      type: "toolcall_delta",
      contentIndex: block.contentIndex,
      delta: delta.argumentsDelta,
      partial: this.snapshot(),
    });
  }

  /** Close every still-open block with its `_end` event, in the order it was opened. */
  private closeOpenBlocks(stream: AssistantMessageEventStream): void {
    for (const block of this.blocks) {
      if (block.kind === "text") {
        stream.push({
          type: "text_end",
          contentIndex: block.contentIndex,
          content: block.text,
          partial: this.snapshot(),
        });
      } else {
        stream.push({
          type: "toolcall_end",
          contentIndex: block.contentIndex,
          toolCall: {
            type: "toolCall",
            id: block.id,
            name: block.name,
            arguments: parseToolArgs(block.args),
          },
          partial: this.snapshot(),
        });
      }
    }
  }

  /** Finish the turn with the model route's own final, authoritative assembly. */
  finish(stream: AssistantMessageEventStream, message: AssistantMessage): void {
    this.ensureStarted(stream);
    this.closeOpenBlocks(stream);
    stream.push({
      type: "done",
      reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
      message,
    });
  }

  fail(stream: AssistantMessageEventStream, reason: "error" | "aborted", detail: string): void {
    this.ensureStarted(stream);
    this.closeOpenBlocks(stream);
    stream.push({
      type: "error",
      reason,
      error: { ...assistantShell(reason, this.snapshot().content), errorMessage: detail },
    });
  }
}
