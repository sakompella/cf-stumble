// oxlint-disable import/max-dependencies -- The facet is where Pi Durable, its storage, the model route, the prompt and the workspace meet.
import { DurableObject } from "cloudflare:workers";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import {
  createRegistry,
  Harness,
  watchEvents,
  type AgentEvent,
  type Conversation,
  type ConversationId,
  type HarnessSettings,
} from "@earendil-works/pi-durable";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { PI_DURABLE_VERSION } from "../../pi-durable-version.js";
import type { ConversationFacet, ConversationHost } from "../conversation-protocol.js";
import type { ModelCapability } from "./capabilities.js";
import { createComputerEnv } from "./execution-env.js";
import { CfStumblePrompt } from "./prompt.js";
import { ROUTE_MODEL, routeProvider } from "./route-provider.js";

const context = BACKGROUND_CONTEXT;

/** The policy generation 0 used: compact above 64k tokens less Pi's 16k answer reserve, keeping the newest 8k. */
const CONTEXT_BUDGET_TOKENS = 64_000;

const ANSWER_RESERVE_TOKENS = 16_384;

const SETTINGS: HarnessSettings = {
  compaction: {
    reserveTokens: ROUTE_MODEL.contextWindow - CONTEXT_BUDGET_TOKENS + ANSWER_RESERVE_TOKENS,
    keepRecentTokens: 8_000,
    backgroundTokens: 0,
  },
};

type ReceivedHost = ConversationHost & Readonly<{ dup(): ConversationHost }>;

type Session = Readonly<{ harness: Harness; host: ConversationHost }>;

const encoder = new TextEncoder();

const KEEPALIVE_LINE = encoder.encode("\n");

const KEEPALIVE_MS = 2_000;

/**
 * The use's context ends when the use is aborted or done. The env kills its running commands
 * through the stub before the stub goes: a kill sent on a disposed stub fails, and the command
 * would run to its end.
 */
async function computerEnv(
  host: ConversationHost,
  conversationId: string,
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<ExecutionEnv> {
  const target = await host.workspace(conversationId);
  const env = createComputerEnv({ cwd, target });

  const end = () => {
    void env.cleanup(context).finally(() => {
      target[Symbol.dispose]();
    });
  };

  if (signal?.aborted === true) end();
  else signal?.addEventListener("abort", end, { once: true });

  return env;
}

/**
 * Generation 1's main facet (ADR-0048). Pi Durable's session lives in this facet's own SQLite,
 * opened on the first `attach` so a startup-check candidate never touches it. Facets cannot set
 * alarms (setting one leaves the facet unusable), so every wake goes to the host's `arm`.
 */
export class MainFacet
  extends DurableObject<Readonly<{ MODEL: ModelCapability }>>
  implements ConversationFacet
{
  #session: Promise<Session> | undefined;

  override fetch(request: Request): Promise<Response> {
    return Promise.resolve(
      new URL(request.url).pathname === "/"
        ? new Response("ready")
        : new Response("Not found", { status: 404 }),
    );
  }

  piDurableVersion(): string {
    return PI_DURABLE_VERSION;
  }

  /**
   * Arming from the session's own wake on every attach renews the recovery heartbeat the
   * Supervisor's alarm consumed, and `resume` continues the work a lost instance left.
   */
  async attach(host: ReceivedHost): Promise<void> {
    if (this.#session === undefined) {
      const opening = this.#open(host.dup());

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

  /**
   * One JSON line per agent event, the snapshot first; cancelling the stream stops the watch.
   * Workers RPC tells a stream's source that its reader left only when the source next writes, so
   * a quiet stream writes an empty line now and then.
   */
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

  /**
   * Answers once the abort is queued on the session's commit line, ahead of any later call. Pi
   * Durable's abort then waits until the conversation is idle, which lasts as long as a running
   * tool takes to stop, so nobody waits for it here.
   */
  async abort(conversationId: string): Promise<void> {
    const conversation = await this.#conversation(conversationId);
    const { harness, host } = await this.#opened();

    await host.arm({ ...harness.wake(), active: true });
    void conversation
      .abort(context)
      .then(() => host.arm(harness.wake()))
      .catch(() => {});
  }

  async #open(host: ConversationHost): Promise<Session> {
    const models = createModels();
    models.setProvider(routeProvider(this.env.MODEL));
    const registry = createRegistry();
    registry.install(CodingTools);
    registry.install(CfStumblePrompt);

    const harness = await Harness.open(
      await openDurableObjectSqliteStorage(this.ctx.storage),
      {
        models,
        registry,
        settings: SETTINGS,
        // The Supervisor ends a capability when the run settles, so each use asks for a live one,
        // and the stub goes when the use's context ends, since Pi Durable never cleans an env up.
        env: ({ conversationId, cwd }, invocation) =>
          cwd === undefined
            ? undefined
            : computerEnv(host, String(conversationId), cwd, invocation.abortSignal),
        // A wake the Supervisor did not arm could strand work, so the instance starts over.
        onWake: (wake) => {
          void host.arm(wake).catch(() => {
            this.ctx.abort("the Supervisor did not arm a wake");
          });
        },
      },
      context,
    );

    return { harness, host };
  }

  /** The Supervisor attaches before every other call. */
  #opened(): Promise<Session> {
    return this.#session ?? Promise.reject(new Error("attach first"));
  }

  /**
   * `onWake` runs after the commit that starts work, so the heartbeat is armed first; the wake
   * after the call corrects it when the call started nothing, such as a repeated request ID.
   */
  async #startingWork<T>(call: () => Promise<T>): Promise<T> {
    const { harness, host } = await this.#opened();

    await host.arm({ ...harness.wake(), active: true });
    const result = await call();
    await host.arm(harness.wake());

    return result;
  }

  async #conversation(conversationId: string): Promise<Conversation> {
    const { harness } = await this.#opened();
    // SAFETY: Pi Durable's conversation ids are numbers, and the Supervisor only hands back the
    // decimal strings `createConversation` returned; an unknown one finds no conversation.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const id = Number(conversationId) as ConversationId;

    const conversation = await harness.conversation(id, context);

    if (conversation === undefined) throw new Error("no such conversation");

    return conversation;
  }
}
