import { parseStreamingJson, parseToolCallArguments } from "@earendil-works/pi-ai";
import type {
  Api,
  AssistantMessage,
  AssistantMessageDiagnostic,
  AssistantMessageEventStream,
  JsonObject,
  Model,
  ToolCall,
  Usage,
} from "@earendil-works/pi-ai";
import type { ModelStreamEvent, ModelUsage, ToolCallDelta } from "../../model-route.js";

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

function usageOf(usage: ModelUsage): Usage {
  return {
    input: usage.inputTokens,
    output: usage.outputTokens,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: usage.inputTokens + usage.outputTokens,
    cost: ZERO_COST,
  };
}

const ZERO_USAGE = usageOf({ inputTokens: 0, outputTokens: 0, estimated: false });

export class ReplyAssembler {
  readonly #out: AssistantMessageEventStream;
  readonly #model: Model<Api>;
  readonly #startedAt = Date.now();
  readonly #calls = new Map<number, ToolCall>();
  readonly #argumentText = new Map<ToolCall, string>();
  readonly #partial: AssistantMessage;
  #started = false;
  #fallback: AssistantMessageDiagnostic | undefined;

  constructor(out: AssistantMessageEventStream, model: Model<Api>) {
    this.#out = out;
    this.#model = model;
    this.#partial = this.#message("pending", []);
  }

  apply(event: ModelStreamEvent): void {
    switch (event.type) {
      case "text-delta":
        this.#text(event.delta);

        return;
      case "tool-call-delta":
        this.#toolCall(event.delta);

        return;
      case "done":
        this.#done(event);

        return;
      case "error":
        this.fail(
          "error",
          event.error.detail === undefined
            ? event.error.code
            : `${event.error.detail} (${event.error.code})`,
        );

        return;
      case "provider-fallback":
        this.#fallback = {
          type: event.type,
          timestamp: Date.now(),
          details: { reason: event.reason, limitedUntil: event.limitedUntil },
        };
    }
  }

  fail(reason: "error" | "aborted", detail: string): void {
    this.#out.push({
      type: "error",
      reason,
      error: { ...this.#message(reason, [...this.#partial.content]), errorMessage: detail },
    });
  }

  #message(
    stopReason: AssistantMessage["stopReason"],
    content: AssistantMessage["content"],
    usage = ZERO_USAGE,
  ): AssistantMessage {
    return {
      role: "assistant",
      content,
      api: this.#model.api,
      provider: this.#model.provider,
      model: this.#model.id,
      usage,
      stopReason,
      timestamp: this.#startedAt,
      ...(this.#fallback !== undefined && { diagnostics: [this.#fallback] }),
    };
  }

  #start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#out.push({ type: "start", partial: this.#partial });
  }

  #text(delta: string): void {
    this.#start();
    const { content } = this.#partial;
    let contentIndex = content.length - 1;
    let block = content[contentIndex];

    if (block?.type !== "text") {
      block = { type: "text", text: "" };
      contentIndex = content.push(block) - 1;
      this.#out.push({ type: "text_start", contentIndex, partial: this.#partial });
    }

    block.text += delta;
    this.#out.push({ type: "text_delta", contentIndex, delta, partial: this.#partial });
  }

  #toolCall(delta: ToolCallDelta): void {
    this.#start();
    const existing = this.#calls.get(delta.index);
    const call: ToolCall = existing ?? { type: "toolCall", id: "", name: "", arguments: {} };
    const fragment = delta.argumentsDelta ?? "";
    const argumentText = (this.#argumentText.get(call) ?? "") + fragment;
    call.id = delta.id ?? call.id;
    call.name = delta.name ?? call.name;
    call.arguments = parseStreamingJson<JsonObject>(argumentText);
    this.#argumentText.set(call, argumentText);

    if (existing === undefined) {
      this.#calls.set(delta.index, call);
      const contentIndex = this.#partial.content.push(call) - 1;
      this.#out.push({ type: "toolcall_start", contentIndex, partial: this.#partial });
    }

    if (fragment === "") return;
    this.#out.push({
      type: "toolcall_delta",
      contentIndex: this.#partial.content.indexOf(call),
      delta: fragment,
      partial: this.#partial,
    });
  }

  #closeBlocks(): void {
    for (const [contentIndex, block] of this.#partial.content.entries()) {
      if (block.type === "text") {
        this.#out.push({
          type: "text_end",
          contentIndex,
          content: block.text,
          partial: this.#partial,
        });
      } else if (block.type === "toolCall") {
        const toolCall = { ...block, ...parseToolCallArguments(this.#argumentText.get(block)) };
        this.#out.push({ type: "toolcall_end", contentIndex, toolCall, partial: this.#partial });
      }
    }
  }

  #done({ message, usage, truncated }: Extract<ModelStreamEvent, { type: "done" }>): void {
    this.#start();
    this.#closeBlocks();

    const content: AssistantMessage["content"] = [
      ...(message.content === null || message.content === ""
        ? []
        : [{ type: "text" as const, text: message.content }]),
      ...message.tool_calls.map((call) => ({
        type: "toolCall" as const,
        id: call.id,
        name: call.function.name,
        ...parseToolCallArguments(call.function.arguments),
      })),
    ];

    const reason =
      truncated === true ? "length" : message.tool_calls.length > 0 ? "toolUse" : "stop";

    this.#out.push({
      type: "done",
      reason,
      message: this.#message(reason, content, usageOf(usage)),
    });
  }
}
