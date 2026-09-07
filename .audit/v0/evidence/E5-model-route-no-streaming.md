# E5 — The model route has no streaming interface at all

Status: CONFIRMED by the root agent. Blocks goal criterion 4.
Sharpens architecture-critique finding 4 and roadmap task T4.

`src/model-route.ts` is request/response by TYPE, not by accident:

```ts
export type ModelInference = { run(model: string, input: ProviderPayload): Promise<ProviderResult> };
export type ProviderResult = Readonly<{ response?: string | null; tool_calls?: ReadonlyArray<ToolCall> }>;
export type ModelRouteResponse =
  | Readonly<{ ok: true; message: AssistantMessage }>
  | Readonly<{ ok: false; error: Readonly<{ code: "model-unavailable" }> }>;
```

`ModelRoute.run` awaits `this.env.AI.run(model, input)` and resolves ONE finished
assistant message. Searching `src/model-route.ts` for `stream`, `ReadableStream`, `SSE`,
or any incremental event type returns nothing.

## Why it blocks v0

Goal criterion 4 requires a streaming conversation in which one real turn reads a file,
edits it, runs the check, and shows tool activity and command output as it happens.
The route cannot emit a partial token or an in-flight tool call, because its return type
is a completed message.

The critique called this "buffers output". That understates it: there is no incremental
interface to buffer. T4 must ADD one and thread it through the facet frames and the page,
which is why T4 cannot be scoped as a small change to an existing stream.

## Fixed constants worth confirming with the owner

`MODEL = "@cf/zai-org/glm-5.3-flash"`, `REASONING_EFFORT = "low"`. That is question Q6:
`.audit/design-questions.md` records a preference for OpenAI. `low` reasoning effort on a
flash model is also a coding-quality risk for the criterion-4 demo turn.
`FORBIDDEN_FIELDS` correctly blocks a client from overriding model, provider, or
credentials — that part is right and should be kept.
