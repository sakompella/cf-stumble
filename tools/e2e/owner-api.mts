import { setTimeout as sleep } from "node:timers/promises";
import * as Schema from "effect/Schema";

const Generation = Schema.Struct({ label: Schema.Number, harnessCommit: Schema.String });

const Status = Schema.Struct({
  activeGeneration: Schema.Struct({ generation: Schema.NullOr(Generation), epoch: Schema.Number }),
});

const Submitted = Schema.Struct({
  outcome: Schema.Struct({ generation: Generation }),
  preparation: Schema.Union([
    Schema.Struct({ ok: Schema.Literal(true) }),
    Schema.Struct({ ok: Schema.Literal(false), problem: Schema.Struct({ code: Schema.String }) }),
  ]),
});

const Connected = Schema.Struct({ project: Schema.Struct({ id: Schema.String }) });

const Live = Schema.Struct({
  run: Schema.optional(Schema.Unknown),
  runFailure: Schema.optional(Schema.Struct({ reason: Schema.String })),
});

const Entry = Schema.Struct({
  id: Schema.Number,
  kind: Schema.String,
  model: Schema.Array(Schema.Unknown),
});

const View = Schema.fromJsonString(
  Schema.Tuple([
    Schema.Tuple([
      Schema.Literal("r"),
      Schema.Struct({
        entries: Schema.Array(Entry),
        docs: Schema.Struct({
          "pi.live": Live,
          "pi.inbox": Schema.Struct({ items: Schema.Array(Schema.Unknown) }),
        }),
      }),
    ]),
  ]),
);

const ToolResult = Schema.Struct({
  content: Schema.Array(Schema.Struct({ text: Schema.optional(Schema.String) })),
});

const Entries = Schema.Struct({ items: Schema.Array(Entry) });

export type ActiveGeneration = typeof Status.Type.activeGeneration;

export type Settled = Readonly<{ failure: string | undefined }>;

export type ConversationEntry = typeof Entry.Type;

type RequestBody = Readonly<Record<string, string | number>>;

export class Owner {
  readonly url: string;
  readonly #authorization: string;

  constructor(url: string, password: string) {
    this.url = url;
    this.#authorization = `Basic ${Buffer.from(`aditya:${password}`).toString("base64")}`;
  }

  #headers() {
    return {
      authorization: this.#authorization,
      "user-agent": "cf-stumble-e2e",
      "content-type": "application/json",
    };
  }

  #fetch(path: string, init: RequestInit): Promise<Response> {
    const request = () => fetch(`${this.url}${path}`, { ...init, headers: this.#headers() });

    return request().catch(async (cause: unknown) => {
      if (!(cause instanceof TypeError)) throw cause;

      await sleep(5_000);

      return request();
    });
  }

  get(path: string): Promise<Response> {
    return this.#fetch(path, {});
  }

  post(path: string, body: RequestBody = {}): Promise<Response> {
    return this.#fetch(path, { method: "POST", body: JSON.stringify(body) });
  }

  async #json<S extends Schema.ConstraintDecoder<unknown>>(response: Promise<Response>, schema: S) {
    const answer = await response;
    const text = await answer.text();

    if (!answer.ok) throw new Error(`${answer.url} answered ${answer.status}: ${text}`);

    return Schema.decodeUnknownSync(Schema.fromJsonString(schema))(text);
  }

  async waitHealthy(limitMs: number): Promise<void> {
    const deadline = Date.now() + limitMs;

    while (Date.now() < deadline) {
      const status = await this.get("/api/status").then(
        (answer) => answer.status,
        () => 0,
      );

      if (status === 200) return;

      await sleep(5_000);
    }

    throw new Error(`${this.url} did not answer /api/status within ${limitMs / 1000} s`);
  }

  async status(): Promise<ActiveGeneration> {
    return (await this.#json(this.get("/api/status"), Status)).activeGeneration;
  }

  async submit(harnessCommit: string): Promise<number> {
    const submitted = await this.#json(
      this.post("/api/generations/submit", {
        harnessCommit,
      }),
      Submitted,
    );

    const { preparation } = submitted;

    if (!preparation.ok) {
      throw new Error(`generation for ${harnessCommit} did not start: ${preparation.problem.code}`);
    }

    return submitted.outcome.generation.label;
  }

  async control(kind: "activate" | "rollback", label: number): Promise<void> {
    const { epoch } = await this.status();

    await this.post(`/api/generations/${kind}`, { label, observedEpoch: epoch }).then(
      async (response) => {
        if (!response.ok) throw new Error(`${kind} ${label} answered ${await response.text()}`);
      },
    );
  }

  async connect(repositoryUrl: string): Promise<string> {
    return (await this.#json(this.post("/api/projects/connect", { repositoryUrl }), Connected))
      .project.id;
  }

  async disconnect(projectId: string): Promise<void> {
    await this.post(`/api/projects/${projectId}/disconnect`);
  }

  async send(projectId: string, content: string): Promise<void> {
    const response = await this.post(`/api/projects/${projectId}/messages`, {
      content,
      requestId: crypto.randomUUID(),
    });

    if (response.status !== 202) throw new Error(`message answered ${await response.text()}`);
  }

  async view(projectId: string) {
    const response = await this.get(`/api/projects/${projectId}/events`);

    if (!response.ok || response.body === null) {
      throw new Error(`events answered ${response.status}`);
    }

    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let text = "";

    while (!text.includes("\n")) {
      const { done, value } = await reader.read();

      if (done) break;

      text += value;
    }

    await reader.cancel();

    return Schema.decodeUnknownSync(View)(text.slice(0, text.indexOf("\n")))[0][1];
  }

  async waitSettled(projectId: string, signal: AbortSignal): Promise<Settled> {
    await sleep(2_000, undefined, { signal });

    for (;;) {
      const { docs } = await this.view(projectId);
      const live = docs["pi.live"];

      if (live.run === undefined && docs["pi.inbox"].items.length === 0) {
        return { failure: live.runFailure?.reason };
      }

      await sleep(3_000, undefined, { signal });
    }
  }

  async entries(projectId: string): Promise<readonly ConversationEntry[]> {
    const page = await this.#json(
      this.get(`/api/projects/${projectId}/entries?limit=100`),
      Entries,
    );

    return page.items;
  }

  async toolOutput(projectId: string, count: number): Promise<string> {
    const results = (await this.entries(projectId))
      .filter((entry) => entry.kind === "pi.tool-result")
      .slice(0, count)
      .toReversed();

    return results
      .flatMap((entry) => Schema.decodeUnknownSync(ToolResult)(entry.model[0]).content)
      .map((part) => part.text ?? "")
      .join("\n");
  }
}
