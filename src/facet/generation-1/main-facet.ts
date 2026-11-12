import { DurableObject } from "cloudflare:workers";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Conversation, ConversationId } from "@earendil-works/pi-durable";
import { FACET_COMPATIBILITY } from "../runtime-contract.js";
import { PacedStream } from "./paced-stream.js";
import { entriesQuery, entryId } from "../entries-query.js";
import type {
  ConversationFacet,
  ConversationHost,
  GenerationControl,
  ModelCapability,
} from "../conversation-protocol.js";
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

type SessionSlot =
  | Readonly<{ kind: "closed" }>
  | Readonly<{ kind: "opening"; opening: Promise<Session> }>
  | Readonly<{ kind: "open"; session: Session }>;

const CLOSED: SessionSlot = { kind: "closed" };

export class MainFacet extends DurableObject implements ConversationFacet {
  #slot: SessionSlot = CLOSED;
  #activeWork = 0;

  compatibility(): string {
    return FACET_COMPATIBILITY;
  }

  async attach(
    host: Received<ConversationHost>,
    model: ModelCapability,
    generations?: Received<GenerationControl>,
  ): Promise<void> {
    const session = await this.#openedOr(() =>
      openSession({
        storage: this.ctx.storage,
        host: host.dup(),
        generations: generations?.dup(),
        model,
        abort: (reason) => {
          this.ctx.abort(reason);
        },
      }),
    );

    await this.#arm(session);
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
    const endWork = await this.#beginWork();

    try {
      const submission = await conversation.submit({ type: "input", content, requestId }, context);

      return submission.id;
    } finally {
      endWork();
    }
  }

  async events(conversationId: string, from?: number): Promise<ReadableStream<Uint8Array>> {
    const conversation = await this.#conversation(conversationId);

    const start = entryId(from);

    const watch = await conversation.watch(
      context,
      start === undefined ? undefined : { from: start },
    );

    const out = new PacedStream(() => {
      clearInterval(keepalive);
      void watch.stop();
    });

    const keepalive = setInterval(() => {
      out.sendIfIdle(KEEPALIVE_LINE);
    }, KEEPALIVE_MS);

    void out.send(encoder.encode(`${JSON.stringify([["r", watch.value]])}\n`));
    watch.start((call) =>
      call.kind === "value"
        ? out.send(encoder.encode(`${JSON.stringify(call.ops)}\n`))
        : Promise.resolve(),
    );
    void watch.closed
      .then(() => {
        out.close();
      })
      .catch(() => {})
      .finally(() => {
        clearInterval(keepalive);
      });

    return out.readable;
  }

  async entries(
    conversationId: string,
    request: Parameters<typeof entriesQuery>[0],
  ): Promise<string> {
    const conversation = await this.#conversation(conversationId);

    const page = await conversation.entries(
      entriesQuery(request),
      request.limit,
      undefined,
      context,
    );

    return JSON.stringify(page);
  }

  async abort(conversationId: string): Promise<void> {
    const conversation = await this.#conversation(conversationId);
    const endWork = await this.#beginWork();

    void conversation
      .abort(context)
      .catch(() => {})
      .finally(endWork);
  }

  #opened(): Promise<Session> {
    const slot = this.#slot;

    switch (slot.kind) {
      case "closed":
        return Promise.reject(new Error("attach first"));
      case "opening":
        return slot.opening;
      case "open":
        return Promise.resolve(slot.session);
      default: {
        const exhaustive: never = slot;

        return exhaustive;
      }
    }
  }

  #openedOr(open: () => Promise<Session>): Promise<Session> {
    if (this.#slot.kind !== "closed") return this.#opened();

    const opening = open();
    this.#slot = { kind: "opening", opening };
    void opening.then(
      (session) => {
        this.#slot = { kind: "open", session };
        void session.harness.closed.then(() => {
          if (this.#slot.kind === "open" && this.#slot.session === session) this.#slot = CLOSED;
        });
      },
      () => {
        this.#slot = CLOSED;
      },
    );

    return opening;
  }

  async #arm({ harness, host }: Session): Promise<void> {
    await host.arm(this.#activeWork > 0 ? { ...harness.wake(), active: true } : harness.wake());
  }

  async #beginWork(): Promise<() => void> {
    const session = await this.#opened();
    this.#activeWork += 1;

    try {
      await this.#arm(session);
    } catch (cause) {
      this.#activeWork -= 1;
      throw cause;
    }

    return () => {
      this.#activeWork -= 1;
      void this.#arm(session).catch(() => {});
    };
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
