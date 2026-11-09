import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import {
  decodeProviderFrame,
  encodeFrame,
  hostFrame,
  ORB_PING,
  ORB_PONG,
  type HostFrame,
  type HostRequest,
  type OrbJob,
  type ProviderReply,
} from "../orb-protocol.js";
import {
  NEW_PROVIDER,
  nextProviderState,
  providerEvent,
  stoppedState,
  decodeProviderAttachment,
  type ProviderAttachment,
  type ProviderContainerEvent,
  type ProviderContainerState,
  type ProviderExit,
} from "./provider-state.js";

const PROVIDER_TAG = "orb-provider";

const REPLACED = 4000;

type Pending = Readonly<{
  socket: WebSocket;
  resolve: (reply: ProviderReply) => void;
  reject: (error: Error) => void;
}>;

export type FetchRequest = Omit<Extract<HostRequest, { _tag: "fetch" }>, "_tag">;

export type FetchResult = Extract<ProviderReply, { _tag: "fetch-result" }>;

function attachmentOf(socket: WebSocket): ProviderAttachment {
  return Option.getOrElse(
    decodeProviderAttachment(socket.deserializeAttachment()),
    () => NEW_PROVIDER,
  );
}

function unexpected(reply: ProviderReply): Error {
  return new Error(`the workspace provider answered with ${reply._tag}`);
}

export class ProviderLink {
  readonly #ctx: DurableObjectState;
  readonly #pending = new Map<number, Pending>();
  #nextId = 0;
  #lastExit: ProviderExit | null = null;

  constructor(ctx: DurableObjectState) {
    this.#ctx = ctx;
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(ORB_PING, ORB_PONG));
  }

  #closeAll(reason: string): void {
    for (const socket of this.#sockets()) {
      this.closed(socket);
      socket.close(REPLACED, reason);
    }
  }

  accept(): Response {
    this.#closeAll("replaced by a new provider");

    const { 0: client, 1: server } = new WebSocketPair();
    this.#ctx.acceptWebSocket(server, [PROVIDER_TAG]);
    server.serializeAttachment(NEW_PROVIDER);

    return new Response(null, { status: 101, webSocket: client });
  }

  egressPort(): number | undefined {
    const socket = this.#socket();

    return socket === undefined ? undefined : (attachmentOf(socket).egressPort ?? undefined);
  }

  state(): ProviderContainerState {
    const socket = this.#socket();

    if (socket === undefined) return stoppedState(this.#lastExit);

    return attachmentOf(socket).container;
  }

  update(event: ProviderContainerEvent): void {
    const socket = this.#socket();

    if (socket !== undefined) this.#updateOn(socket, event);
  }

  received(socket: WebSocket, message: string | ArrayBuffer): void {
    const frame = Option.getOrUndefined(decodeProviderFrame(message));

    if (frame === undefined) {
      socket.close(1003, "unreadable frame");

      return;
    }

    if (Predicate.isTagged(frame, "hello")) {
      socket.serializeAttachment({ ...attachmentOf(socket), egressPort: frame.egressPort });
    } else if (Predicate.isTagged(frame, "exited")) {
      this.#updateOn(
        socket,
        providerEvent.exited({
          runtime: frame.runtime,
          exit: { exitedAt: Date.now(), reason: frame.reason },
        }),
      );
    } else {
      this.#settle(frame);
    }
  }

  closed(socket: WebSocket): void {
    const exit = { exitedAt: Date.now(), reason: "the workspace provider disconnected" };

    if (socket.readyState !== WebSocket.CLOSED) socket.close(1000, "provider disconnected");

    this.#updateOn(socket, providerEvent.disconnected({ exit }));

    for (const [id, pending] of this.#pending) {
      if (pending.socket !== socket) continue;

      this.#pending.delete(id);
      pending.reject(new Error(exit.reason));
    }
  }

  async job(job: OrbJob, deadlineMs?: number): Promise<string | null> {
    const reply = await this.#request((id) => hostFrame.job({ id, job }), null, deadlineMs);

    if (!Predicate.isTagged(reply, "job-done")) throw unexpected(reply);

    return reply.runtime;
  }

  async fetch(request: FetchRequest, signal?: AbortSignal | null): Promise<FetchResult> {
    const reply = await this.#request((id) => hostFrame.fetch({ id, ...request }), signal);

    if (!Predicate.isTagged(reply, "fetch-result")) throw unexpected(reply);

    return reply;
  }

  #sockets(): WebSocket[] {
    return this.#ctx.getWebSockets(PROVIDER_TAG);
  }

  #socket(): WebSocket | undefined {
    return this.#sockets().find((socket) => socket.readyState === WebSocket.OPEN);
  }

  #updateOn(socket: WebSocket, event: ProviderContainerEvent): void {
    const attachment = attachmentOf(socket);
    const container = nextProviderState(attachment.container, event);

    if (container !== attachment.container && Predicate.isTagged(container, "stopped"))
      this.#lastExit = container.exit;

    socket.serializeAttachment({ ...attachment, container } satisfies ProviderAttachment);
  }

  #settle(reply: ProviderReply): void {
    const pending = this.#pending.get(reply.id);

    if (pending === undefined) return;

    this.#pending.delete(reply.id);

    if (Predicate.isTagged(reply, "failed")) pending.reject(new Error(reply.message));
    else pending.resolve(reply);
  }

  #request(
    frame: (id: number) => HostFrame,
    signal?: AbortSignal | null,
    deadlineMs?: number,
  ): Promise<ProviderReply> {
    const socket = this.#socket();

    if (socket === undefined)
      return Promise.reject(new Error("no workspace provider is connected"));

    const id = this.#nextId++;

    return new Promise<ProviderReply>((resolve, reject) => {
      const abandon = (): void => {
        this.#pending.delete(id);
        reject(signal?.reason instanceof Error ? signal.reason : new Error("request aborted"));
      };

      signal?.addEventListener("abort", abandon, { once: true });

      const overdue =
        deadlineMs === undefined
          ? undefined
          : setTimeout(() => {
              this.closed(socket);
            }, deadlineMs);

      const settled = (): void => {
        clearTimeout(overdue);
        signal?.removeEventListener("abort", abandon);
      };

      this.#pending.set(id, {
        socket,
        resolve: (reply) => {
          settled();
          resolve(reply);
        },
        reject: (error) => {
          settled();
          reject(error);
        },
      });
      socket.send(encodeFrame(frame(id)));
    });
  }
}
