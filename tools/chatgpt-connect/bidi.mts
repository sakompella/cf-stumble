import { ToolError } from "./error.mjs";
import { parseJsonRecord, type CdpResult } from "../browser-harness/cdp.mjs";
import { type JsonRecord } from "../json.mjs";

type Pending = Readonly<{
  resolve: (result: CdpResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}>;

export class Bidi {
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();
  private listener: (event: CdpResult) => void = () => {};

  private readonly socket: WebSocket;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener("message", (event) => {
      const message = parseJsonRecord(String(event.data));
      const id = message?.count("id");

      if (message === undefined) {
        return;
      }

      if (id === undefined) {
        this.listener(message);

        return;
      }

      const pending = this.pending.get(id);

      if (pending === undefined) {
        return;
      }

      clearTimeout(pending.timer);
      this.pending.delete(id);

      if (message.text("type") === "error") {
        pending.reject(new ToolError("Firefox rejected a BiDi command"));
      } else {
        pending.resolve(message);
      }
    });
    socket.addEventListener("close", () => {
      this.close();
    });
  }

  static async open(url: string, signal: AbortSignal): Promise<Bidi> {
    const endpoint = new URL(url);

    endpoint.pathname = "/session";

    const socket = new WebSocket(endpoint);

    await new Promise<void>((resolve, reject) => {
      const abort = (): void => {
        socket.close();
        reject(new ToolError("Interrupted"));
      };

      signal.addEventListener("abort", abort, { once: true });
      socket.addEventListener(
        "open",
        () => {
          signal.removeEventListener("abort", abort);
          resolve();
        },
        { once: true },
      );
      socket.addEventListener(
        "error",
        () => {
          signal.removeEventListener("abort", abort);
          reject(new ToolError("Could not open BiDi socket"));
        },
        { once: true },
      );
    });

    return new Bidi(socket);
  }

  onEvent(listener: (event: CdpResult) => void): void {
    this.listener = listener;
  }

  send(method: string, params: JsonRecord = {}): Promise<CdpResult> {
    const id = this.nextId++;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ToolError("Firefox command timed out"));
      }, 15_000);

      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new ToolError("Firefox connection closed"));
    }

    this.pending.clear();

    if (this.socket.readyState < WebSocket.CLOSING) {
      this.socket.close();
    }
  }
}
