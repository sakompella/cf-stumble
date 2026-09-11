import {
  isJsonArray,
  isJsonNumber,
  isJsonRecord,
  isJsonString,
  parseJsonRecordText,
  type JsonRecord,
  type JsonValue,
} from "./json.mjs";

/**
 * The DevTools Protocol connection, and the one place a DevTools message is turned from text into
 * typed data.
 *
 * The harness talks to a real Chrome over a raw WebSocket rather than through a driver library,
 * because this repository refuses new npm dependencies for a check that has to run in CI. That
 * trade costs exactly one thing: the protocol carries no types here, so every reply is JSON of
 * unproven shape. This module pays that cost once. A caller receives a {@link CdpResult}, which
 * reads named fields at a stated type and answers `undefined` when the field is absent or of
 * another type, so no unproven value travels further into the harness.
 */

/**
 * Walk a dotted path. A numeric step indexes an array, because DevTools puts the interesting part
 * of a console call in `args.0.value`. A step whose parent is neither a record nor an array ends
 * the walk at `undefined`: a missing field and a wrongly-typed one are the same fact to a caller,
 * which is that the browser did not say what was needed.
 */
function valueAtPath(root: JsonRecord, path: string): JsonValue | undefined {
  let current: JsonValue | undefined = root;

  for (const step of path.split(".")) {
    if (current === undefined) {
      return undefined;
    }

    if (isJsonArray(current)) {
      const index = Math.trunc(Number(step));
      current = Number.isInteger(index) ? current[index] : undefined;
      continue;
    }

    if (!isJsonRecord(current)) {
      return undefined;
    }

    current = current[step];
  }

  return current;
}

/** One DevTools reply, read by name. */
export type CdpResult = Readonly<{
  value: (path: string) => JsonValue | undefined;
  text: (path: string) => string | undefined;
  count: (path: string) => number | undefined;
  json: () => string;
}>;

function cdpResult(raw: JsonRecord): CdpResult {
  const value = (path: string): JsonValue | undefined => valueAtPath(raw, path);

  return {
    value,
    text: (path) => {
      const found = value(path);

      return found !== undefined && isJsonString(found) ? found : undefined;
    },
    count: (path) => {
      const found = value(path);

      return found !== undefined && isJsonNumber(found) ? found : undefined;
    },
    json: () => JSON.stringify(raw),
  };
}

/** The same reader over a JSON document that arrived some other way (a DevTools HTTP endpoint). */
export function parseJsonRecord(text: string): CdpResult | undefined {
  const parsed = parseJsonRecordText(text);

  return parsed === undefined ? undefined : cdpResult(parsed);
}

type Pending = Readonly<{
  resolve: (result: CdpResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}>;

/** An event the harness watches. Console output and log entries both arrive this way. */
export type CdpEventListener = (params: CdpResult) => void;

/**
 * One listener, and the session it cares about.
 *
 * A flattened attachment carries every page's events over one socket, so a listener that ignored
 * `sessionId` would collect the faults of a tab that some other case was driving.
 */
type Subscription = Readonly<{ listener: CdpEventListener; sessionId: string | undefined }>;

/**
 * A connection to one DevTools endpoint. Session-scoped commands carry a `sessionId`, which is how
 * one socket drives both the browser and a page (`flatten` attachment).
 */
export class CdpConnection {
  private readonly socket: WebSocket;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Map<string, Subscription[]>();
  private readonly commandTimeoutMs: number;

  private constructor(socket: WebSocket, commandTimeoutMs: number) {
    this.socket = socket;
    this.commandTimeoutMs = commandTimeoutMs;
    socket.addEventListener("message", (event) => {
      this.dispatch(String(event.data));
    });
    socket.addEventListener("close", () => {
      this.failAll(new Error("the DevTools socket closed while a command was in flight"));
    });
  }

  static open(webSocketUrl: string, commandTimeoutMs = 15_000): Promise<CdpConnection> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(webSocketUrl);
      socket.addEventListener("open", () => {
        resolve(new CdpConnection(socket, commandTimeoutMs));
      });
      socket.addEventListener("error", () => {
        reject(new Error(`could not open the DevTools socket at ${webSocketUrl}`));
      });
    });
  }

  /** Send one command. A DevTools `error` reply rejects, so a wrong command cannot pass silently. */
  send(method: string, params: JsonRecord = {}, sessionId?: string): Promise<CdpResult> {
    const id = this.nextId;
    this.nextId += 1;

    const message =
      sessionId === undefined ? { id, method, params } : { id, method, params, sessionId };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(`DevTools command ${method} did not answer in ${this.commandTimeoutMs}ms`),
        );
      }, this.commandTimeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify(message));
    });
  }

  onEvent(method: string, listener: CdpEventListener, sessionId?: string): void {
    const subscription: Subscription = { listener, sessionId };
    const existing = this.listeners.get(method);

    if (existing === undefined) {
      this.listeners.set(method, [subscription]);

      return;
    }

    existing.push(subscription);
  }

  close(): void {
    this.failAll(new Error("the harness closed the DevTools socket"));
    this.socket.close();
  }

  private dispatch(text: string): void {
    const message = parseJsonRecordText(text);

    if (message === undefined) {
      return;
    }

    const result = cdpResult(message);
    const id = result.count("id");

    if (id === undefined) {
      this.dispatchEvent(result);

      return;
    }

    this.settle(id, result);
  }

  private dispatchEvent(result: CdpResult): void {
    const method = result.text("method");

    if (method === undefined) {
      return;
    }

    const session = result.text("sessionId");
    const params = result.value("params");
    const payload = params !== undefined && isJsonRecord(params) ? params : {};

    for (const subscription of this.listeners.get(method) ?? []) {
      if (subscription.sessionId !== undefined && subscription.sessionId !== session) {
        continue;
      }

      subscription.listener(cdpResult(payload));
    }
  }

  private settle(id: number, result: CdpResult): void {
    const pending = this.pending.get(id);

    if (pending === undefined) {
      return;
    }

    this.pending.delete(id);
    clearTimeout(pending.timer);
    const errorMessage = result.text("error.message");

    if (errorMessage !== undefined) {
      pending.reject(new Error(`DevTools rejected the command: ${errorMessage}`));

      return;
    }

    const value = result.value("result");
    pending.resolve(cdpResult(value !== undefined && isJsonRecord(value) ? value : {}));
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }

    this.pending.clear();
  }
}
