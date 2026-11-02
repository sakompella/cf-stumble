import { DurableObject } from "cloudflare:workers";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  watchEvents,
  type AgentEvent,
  type Conversation,
  type ConversationId,
} from "@earendil-works/pi-durable";
import { FACET_COMPATIBILITY } from "../../facet-compatibility.js";
import type {
  ConversationFacet,
  ConversationHost,
  GenerationControl,
} from "../conversation-protocol.js";
import type { ModelCapability } from "./capabilities.js";
import { openSession, type Session } from "./open-session.js";
import { ROUTE_MODEL } from "./route-provider.js";

const context = BACKGROUND_CONTEXT;

function isConversationId(value: number): value is ConversationId {
  return Number.isSafeInteger(value) && value >= 0;
}

type Received<T> = T & Readonly<{ dup(): T }>;

const encoder = new TextEncoder();

const KEEPALIVE_LINE = encoder.encode("\n");

const KEEPALIVE_MS = 2_000;

export class MainFacet
  extends DurableObject<Readonly<{ MODEL: ModelCapability }>>
  implements ConversationFacet
{
  #session: Promise<Session> | undefined;

  compatibility(): string {
    return FACET_COMPATIBILITY;
  }

  async attach(
    host: Received<ConversationHost>,
    generations?: Received<GenerationControl>,
  ): Promise<void> {
    if (this.#session === undefined) {
      const opening = openSession({
        storage: this.ctx.storage,
        host: host.dup(),
        generations: generations?.dup(),
        model: this.env.MODEL,
        abort: (reason) => {
          this.ctx.abort(reason);
        },
      });

      this.#session = opening;
      void opening.catch(() => {
        this.#session = undefined;
      });
    }

    const session = await this.#session;

    await session.host.arm(session.harness.wake());
    session.harness.resume();
  }

  async createConversation(cwd: string): Promise<string> {
    const { harness } = await this.#opened();

    const conversation = await harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: {
          model: { provider: ROUTE_MODEL.provider, modelId: ROUTE_MODEL.id },
          thinkingLevel: "off",
          cwd,
        },
      },
      context,
    );

    return String(conversation.id);
  }

  async submit(conversationId: string, content: string, requestId: string): Promise<number> {
    const conversation = await this.#conversation(conversationId);

    const submission = await this.#startingWork(() =>
      conversation.submit({ type: "input", content, requestId }, context),
    );

    return submission.id;
  }

  async events(conversationId: string): Promise<ReadableStream<Uint8Array>> {
    const { harness } = await this.#opened();
    const { id } = await this.#conversation(conversationId);
    const watch = await watchEvents(harness, id, context);
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const write = (event: AgentEvent) => writer.write(encoder.encode(`${JSON.stringify(event)}\n`));

    const keepalive = setInterval(() => {
      void writer.write(KEEPALIVE_LINE).catch(() => {});
    }, KEEPALIVE_MS);

    void write(watch.snapshot).catch(() => {});
    watch.start(async (events) => {
      for (const event of events) await write(event);
    });
    void writer.closed
      .catch(() => watch.stop())
      .finally(() => {
        clearInterval(keepalive);
      });
    void watch.closed.then(() => writer.close()).catch(() => {});

    return readable;
  }

  async abort(conversationId: string): Promise<void> {
    const conversation = await this.#conversation(conversationId);
    const { harness, host } = await this.#opened();

    await host.arm({ ...harness.wake(), active: true });
    void conversation
      .abort(context)
      .then(() => host.arm(harness.wake()))
      .catch(() => {});
  }

  #opened(): Promise<Session> {
    return this.#session ?? Promise.reject(new Error("attach first"));
  }

  async #startingWork<T>(call: () => Promise<T>): Promise<T> {
    const { harness, host } = await this.#opened();

    await host.arm({ ...harness.wake(), active: true });
    const result = await call();
    await host.arm(harness.wake());

    return result;
  }

  async #conversation(conversationId: string): Promise<Conversation> {
    const { harness } = await this.#opened();
    const id = Number(conversationId);

    if (!isConversationId(id)) throw new Error("no such conversation");

    const conversation = await harness.conversation(id, context);

    if (conversation === undefined) throw new Error("no such conversation");

    return conversation;
  }
}
