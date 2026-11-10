import { setTimeout as sleep } from "node:timers/promises";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { Owner } from "../owner-api.mts";

const Optional = Schema.optionalKey;

const Doc = Schema.Struct({
  activeGeneration: Optional(
    Schema.Struct({
      epoch: Optional(Schema.Number),
      generation: Optional(
        Schema.Struct({
          label: Schema.Number,
          harnessCommit: Schema.String,
          status: Schema.String,
        }),
      ),
    }),
  ),
  outcome: Optional(
    Schema.Struct({
      generation: Optional(Schema.Struct({ label: Schema.Number })),
      epoch: Optional(Schema.Number),
      effect: Optional(Schema.String),
    }),
  ),
  preparation: Optional(
    Schema.Struct({ report: Optional(Schema.Struct({ stage: Schema.String })) }),
  ),
  problem: Optional(Schema.Struct({ code: Schema.String })),
  project: Optional(Schema.Struct({ id: Optional(Schema.String) })),
  projects: Optional(Schema.Array(Schema.Struct({ id: Schema.String }))),
  workspace: Optional(Schema.String),
});

type Doc = typeof Doc.Type;

const readDoc = Schema.decodeUnknownOption(Schema.fromJsonString(Doc));

export type Body = Readonly<Record<string, string | number>>;

export type Reply = Readonly<{ status: number; text: string; doc: Doc }>;

function parseDoc(text: string): Doc {
  return Option.getOrElse(readDoc(text), (): Doc => ({}));
}

type TraceEntry = Readonly<{ atMs: number; line: string }>;

const EXCERPT = 240;

export class Probe {
  readonly owner: Owner;
  readonly violations: string[] = [];
  readonly trace: TraceEntry[] = [];
  readonly #startedMs = Date.now();
  readonly counts = new Map<string, number>();
  #leftover = false;

  constructor(owner: Owner) {
    this.owner = owner;
  }

  note(line: string): void {
    this.trace.push({ atMs: Date.now() - this.#startedMs, line });
  }

  count(key: string): void {
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
  }

  violation(message: string): void {
    this.note(`VIOLATION ${message}`);
    this.violations.push(message);
  }

  async http(method: "GET" | "POST", path: string, body?: Body, raw?: string): Promise<Reply> {
    const sent = raw ?? (body === undefined ? undefined : JSON.stringify(body));
    const label = `${method} ${path} ${sent === undefined ? "" : sent.slice(0, 120)}`;

    this.note(`-> ${label}`);

    const response = await (method === "GET"
      ? this.owner.get(path)
      : this.owner.postRaw(path, sent ?? ""));

    const text = await response.text();

    this.note(`<- ${response.status} ${text.slice(0, EXCERPT)}`);
    this.count(`${method} ${path.split("?")[0] ?? path} ${response.status}`);

    const doc = parseDoc(text);

    this.trackLeftover(path, response.status, doc);

    if (response.status >= 500 && !this.#knownLeftoverRefusal(path, response.status)) {
      this.violation(`${label} answered ${response.status}: ${text.slice(0, EXCERPT)}`);
    }

    return { status: response.status, text, doc };
  }

  trackLeftover(path: string, status: number, doc: Doc): void {
    if (path.endsWith("/disconnect") && doc.workspace === "failed") {
      this.#leftover = true;
      this.count("known: disconnect left the workspace directory (open finding 2)");
    } else if (path === "/api/projects/connect" && status === 200) {
      this.#leftover = false;
    }
  }

  #knownLeftoverRefusal(path: string, status: number): boolean {
    if (path !== "/api/projects/connect" || status !== 503 || !this.#leftover) return false;

    this.#leftover = false;
    this.count("known: connect refused after a failed disconnect (open finding 2)");

    return true;
  }

  dump(limit = 60): string {
    return this.trace
      .slice(-limit)
      .map((entry) => `${String(entry.atMs).padStart(7)}ms ${entry.line}`)
      .join("\n");
  }
}

export async function pollUntil(
  limitMs: number,
  signal: AbortSignal,
  check: () => Promise<boolean>,
): Promise<boolean> {
  const deadline = Date.now() + limitMs;

  while (Date.now() < deadline) {
    if (await check()) return true;

    await sleep(1_500, undefined, { signal });
  }

  return false;
}
