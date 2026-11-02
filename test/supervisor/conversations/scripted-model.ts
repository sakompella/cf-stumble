import * as Schema from "effect/Schema";
import { vi } from "vitest";

const RESPONSES_URL = "https://api.openai.com/v1/responses";

const decodeResponsesBody = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ input: Schema.Array(Schema.Json) })),
);

type ResponsesInput = readonly Schema.Json[];

function isText(body: BodyInit | null | undefined): body is string {
  return typeof body === "string";
}

type Answer = () => Promise<Response>;

function sse(events: readonly object[]): Response {
  const body = [...events, { type: "response.completed", response: {} }]
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join("");

  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

export const says =
  (text: string): Answer =>
  () =>
    Promise.resolve(sse([{ type: "response.output_text.delta", output_index: 0, delta: text }]));

export const calls =
  (name: string, args: Readonly<Record<string, string>>): Answer =>
  () =>
    Promise.resolve(
      sse([
        {
          type: "response.output_item.added",
          output_index: 0,
          item: { type: "function_call", call_id: "call_1", name, arguments: JSON.stringify(args) },
        },
      ]),
    );

export function held() {
  let released: Answer | undefined;

  const respond: Answer = async () => {
    const answer = await vi.waitUntil(() => released, { timeout: 15_000, interval: 10 });

    return answer();
  };

  return {
    respond,
    release: (answer: Answer) => {
      released = answer;
    },
  };
}

export function scriptModel(...answers: readonly Answer[]) {
  const inputs: ResponsesInput[] = [];
  const queue = [...answers];

  vi.spyOn(globalThis, "fetch").mockImplementation((url, init) => {
    if (new Request(url).url !== RESPONSES_URL)
      return Promise.resolve(new Response("{}", { status: 404 }));
    const body = init?.body;

    if (!isText(body)) return Promise.reject(new Error("the model turn must send a JSON body"));
    inputs.push(decodeResponsesBody(body).input);
    const answer = queue.shift();

    if (answer === undefined)
      return Promise.reject(new Error("the scripted model has no answer left"));

    return answer();
  });

  const asked = (count: number) =>
    vi.waitUntil(() => inputs.length === count, { timeout: 10_000, interval: 10 });

  return { inputs, asked };
}
