import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import { request, type RequestOptions } from "node:https";
import type { IncomingMessage } from "node:http";

export type BodySpec =
  | Readonly<{ kind: "text"; text: string }>
  | Readonly<{ kind: "repeat"; prefix: string; unit: string; count: number; suffix: string }>
  | Readonly<{ kind: "nest"; open: string; close: string; depth: number; core: string }>
  | Readonly<{ kind: "bytes"; hex: string }>;

export type Header = readonly [string, string];

export type Credential = "valid" | "invalid" | "either";

export type Case = Readonly<{
  method: string;
  path: string;
  headers: readonly Header[];
  body: BodySpec | undefined;
  credential: Credential;
}>;

export type Reply = Readonly<{
  status: number;
  headers: readonly Header[];
  body: string;
  ms: number;
  error: string | undefined;
}>;

const REPLY_LIMIT = 262_144;

const REQUEST_LIMIT_MS = 30_000;

const STREAM_WINDOW_MS = 2_000;

export function bodyBytes(body: BodySpec | undefined): Buffer {
  if (body === undefined) return Buffer.alloc(0);

  if (body.kind === "bytes") return Buffer.from(body.hex, "hex");

  if (body.kind === "text") return Buffer.from(body.text, "utf8");

  if (body.kind === "nest") {
    return Buffer.from(
      `${body.open.repeat(body.depth)}${body.core}${body.close.repeat(body.depth)}`,
      "utf8",
    );
  }

  return Buffer.from(`${body.prefix}${body.unit.repeat(body.count)}${body.suffix}`, "utf8");
}

export function approximateSize(body: BodySpec | undefined): number {
  if (body === undefined) return 0;

  if (body.kind === "bytes") return body.hex.length / 2;

  if (body.kind === "text") return body.text.length;

  if (body.kind === "nest") {
    return body.depth * (body.open.length + body.close.length) + body.core.length;
  }

  return body.unit.length * body.count + body.prefix.length + body.suffix.length;
}

function encode(text: string): string {
  return Buffer.from(text).toString("base64");
}

export function credentialTokens(password: string) {
  const valid = encode(`aditya:${password}`);

  return {
    "{valid}": valid,
    "{unpadded}": valid.replace(/=+$/u, ""),
    "{wrong}": encode("aditya:wrong-password"),
    "{other-user}": encode(`root:${password}`),
    "{no-user}": encode(password),
    "{user-only}": encode("aditya:"),
    "{newline}": encode(`aditya:${password}\n`),
    "{doubled}": `${valid}${valid}`,
  } as const;
}

function expand(value: string, password: string): string {
  return Object.entries(credentialTokens(password)).reduce(
    (text, [key, replacement]) => text.replaceAll(key, replacement),
    value,
  );
}

function readHeaders(raw: readonly string[]): Header[] {
  const headers: Header[] = [];

  for (let index = 0; index + 1 < raw.length; index += 2) {
    headers.push([(raw[index] ?? "").toLowerCase(), raw[index + 1] ?? ""]);
  }

  return headers;
}

const DECODERS = new Map([
  ["gzip", gunzipSync],
  ["br", brotliDecompressSync],
  ["deflate", inflateSync],
]);

function decoded(raw: Buffer, headers: readonly Header[]): Buffer {
  const decoder = DECODERS.get(headers.find(([name]) => name === "content-encoding")?.[1] ?? "");

  if (decoder === undefined) return raw;

  try {
    return decoder(raw);
  } catch {
    return raw;
  }
}

class Exchange {
  readonly #chunks: Buffer[] = [];
  readonly #began = Date.now();
  readonly #resolve: (reply: Reply) => void;
  #size = 0;
  #status = 0;
  #headers: Header[] = [];
  #done = false;
  failure: string | undefined;

  constructor(resolve: (reply: Reply) => void) {
    this.#resolve = resolve;
  }

  get status(): number {
    return this.#status;
  }

  finish(): void {
    if (this.#done) return;

    this.#done = true;
    this.#resolve({
      status: this.#status,
      headers: this.#headers,
      body: decoded(Buffer.concat(this.#chunks), this.#headers).toString("latin1"),
      ms: Date.now() - this.#began,
      error: this.failure,
    });
  }

  accept(response: IncomingMessage): void {
    this.#status = response.statusCode ?? 0;
    this.#headers = readHeaders(response.rawHeaders);

    const streaming = this.#headers.some(
      ([name, value]) => name === "content-type" && value.includes("ndjson"),
    );

    if (streaming) {
      setTimeout(() => {
        response.destroy();
      }, STREAM_WINDOW_MS);
    }

    response.on("data", (chunk: Buffer) => {
      if (this.#size < REPLY_LIMIT) this.#chunks.push(chunk);

      this.#size += chunk.length;
    });

    for (const event of ["end", "close", "error"]) {
      response.on(event, () => {
        this.finish();
      });
    }
  }
}

function options(target: URL, probe: Case, password: string): RequestOptions {
  return {
    host: target.hostname,
    port: 443,
    method: probe.method,
    path: probe.path,
    agent: false,
    servername: target.hostname,
    headers: [
      "host",
      target.hostname,
      ...probe.headers.flatMap(([name, value]) => [name, expand(value, password)]),
    ],
  };
}

export function send(url: string, password: string, probe: Case): Promise<Reply> {
  const target = new URL(url);

  return new Promise((resolve) => {
    const exchange = new Exchange(resolve);

    const outgoing = request(options(target, probe, password), (response) => {
      exchange.accept(response);
    });

    outgoing.setTimeout(REQUEST_LIMIT_MS, () => {
      exchange.failure = `no complete answer within ${REQUEST_LIMIT_MS / 1000} s`;
      outgoing.destroy();
    });
    outgoing.on("error", (cause) => {
      exchange.failure ??= cause.message;
      exchange.finish();
    });
    outgoing.end(bodyBytes(probe.body));
  });
}
