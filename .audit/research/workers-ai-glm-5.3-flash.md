# Workers AI `@cf/zai-org/glm-5.3-flash` research

_Date checked: 2026-09-03. Sources are Cloudflare documentation unless noted._

## Findings

- The exact Cloudflare model ID is `@cf/zai-org/glm-5.3-flash`. Cloudflare lists it as a hosted text-generation model with function calling, reasoning, and vision. Its context window is 1,048,576 tokens. The model page's synchronous and streaming parameter schemas list `reasoning_effort` as `string | null`, with the enum `low`, `medium`, `high`; its description says that it constrains reasoning effort. Therefore the requested low setting is `reasoning_effort: "low"`, not `chat_template_kwargs.enable_thinking: false` (which disables thinking in the separate Gemma example).
- Cloudflare's model page shows the native Worker call with `await env.AI.run("@cf/zai-org/glm-5.3-flash", { messages })`. The synchronous example returns `Response.json(response)`; the streaming example returns the stream with `content-type: text/event-stream`.
- The Workers binding configuration is:

  ```jsonc
  {
    "ai": { "binding": "AI" }
  }
  ```

  The binding is available as `env.AI`; the TypeScript declaration is `AI: Ai`. The TOML equivalent is `[ai]` / `binding = "AI"`.
- The native call to use for the fixed route is:

  ```ts
  const MODEL = "@cf/zai-org/glm-5.3-flash" as const;
  const result = await env.AI.run(MODEL, {
    messages: [
      { role: "system", content: "You are a coding assistant." },
      { role: "user", content: prompt },
    ],
    reasoning_effort: "low",
  });
  ```

  `messages` is the structured conversation input. Do not set `enable_thinking: false` for this requirement: that is off, rather than low effort.
- The model page documents OpenAI-style synchronous output fields: `id`, `object`, `created`, `model`, `choices`, optional `usage`, and optional `system_fingerprint`/`service_tier`. A choice has `index`, `message`, `finish_reason`, and `logprobs`; the assistant message has `role`, `content`, `refusal`, and optional tool calls. The Cloudflare getting-started guide shows the concrete shape as `object: "chat.completion"`, `model`, one `choices` element with `message.role: "assistant"`, `message.content`, `refusal: null`, `finish_reason: "stop"`, and `logprobs: null`.
- The current installed `@cloudflare/workers-types` in this repository (`node_modules/@cloudflare/workers-types/index.d.ts`) types `Ai.run` with a generic fallback for unknown model IDs, and its generic `AiTextGenerationInput` does not list `reasoning_effort`. The model call still type-checks today because this new model is not in the generated `AiModels` map and reaches the `Record<string, unknown>` fallback. Keep a small adapter and a local payload type so a workers-types update cannot silently change the contract. Treat the paid runtime probe—not TypeScript alone—as proof that the native binding accepts `reasoning_effort` for this model.

## Availability and billing

Cloudflare marks this model **Paid access required** and says it is unavailable through standard Workers Free billing. Use a Workers Paid plan or prepaid AI Gateway credits. The pricing page repeats that `@cf/zai-org/glm-5.3-flash` requires a paid billing method and says AI Gateway credits require Unified billing. The model page lists $0.15/M input tokens, $0.50/M output tokens, and $0.03/M cached input tokens. Local `wrangler dev` inference still accesses the Cloudflare account and incurs usage; it is not an offline fake. The limits page documents text-generation and frontier-model rate limits, but does not list this model in the current frontier table; confirm the account's effective limit during the paid probe rather than assuming a number.

## Minimal paid runtime probe

Add this only in a temporary probe Worker (not the production fixture):

```ts
export interface Env { AI: Ai }
const MODEL = "@cf/zai-org/glm-5.3-flash" as const;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname !== "/probe") {
      return new Response("not found", { status: 404 });
    }
    try {
      const result = await env.AI.run(MODEL, {
        messages: [
          { role: "user", content: "Reply with exactly workers-ai-probe." },
        ],
        reasoning_effort: "low",
      });
      return Response.json({ ok: true, model: MODEL, result });
    } catch (error) {
      return Response.json(
        { ok: false, model: MODEL, error: String(error) },
        { status: 502 },
      );
    }
  },
} satisfies ExportedHandler<Env>;
```

Configure the `ai` binding above, run `pnpm exec wrangler dev` or deploy to a Workers Paid account, then `curl "$URL/probe"`. Record the raw response, status, elapsed time, and account/billing path. The probe passes only if the response is successful, the returned `model` is the exact ID, and the assistant completes the sentinel request. Also run one request with an intentionally invalid model only as a separate negative check; do not make a model error look like an application success.

The extra `reasoning_effort` field is accepted by the current unknown-model TypeScript overload in this repo. If a future generated model type rejects it, preserve the runtime payload with a narrow adapter cast and add a paid probe regression; do not replace it with `enable_thinking: false` without verifying that GLM's API semantics changed.

## Recommended cf-stumble integration seam

The repository has no AI binding yet. `wrangler.jsonc` currently contains `SUPERVISOR`, `LOADER`, and `MODULE_MAPS`; `src/worker.ts` routes all requests to the `facet-spike` Supervisor; `src/supervisor/supervisor.ts` only receives `LOADER`; and `src/facet/index.ts` constructs loaded WorkerCode with `env: {}` and `globalOutbound: null`.

Use an immutable host-side model route rather than putting `AI` directly into every mutable generation:

1. Add the `ai` binding to the root Worker configuration and `AI: Ai` to the host environment type.
2. Export a host `WorkerEntrypoint` (for example `ModelRoute`) from `src/worker.ts`. Its only model method should call `env.AI.run(MODEL, payload)` with the constant model ID and `reasoning_effort: "low"`, then return a plain structured-cloneable result. The mutable facet receives no AI credential and cannot select another model or reasoning level.
3. In `Supervisor`, obtain a loopback service binding from `this.ctx.exports` (Durable Object state exposes `exports`) and pass only that service binding into the loaded WorkerCode, for example `env: { MODEL: this.ctx.exports.ModelRoute }`. Extend `loadMainFacet`/`loadArtifact` to accept this host capability rather than importing or exposing the root `AI` binding. Keep `globalOutbound: null`.
4. Have the real main facet call `env.MODEL.run(...)` through the narrow RPC method. Keep the RPC argument and return value plain JSON/structured-cloneable data. Do not pass the `Ai` object, access token, or a general-purpose `fetcher` into generated code.

This follows Cloudflare's Dynamic Workers API: WorkerCode `env` may receive structured-cloneable values and Service Bindings, while `globalOutbound: null` blocks ambient `fetch()` and `connect()`. Cloudflare's RPC docs require RPC arguments/results to be structured-cloneable (or explicitly supported RPC types), and say calls must be awaited. The model route then remains outside the mutable generation, matching the product rule that the fixed model credential stays outside the facet.

A direct `env: { AI: parentEnv.AI }` pass is not the recommended first seam. Cloudflare's Dynamic Worker contract explicitly guarantees Service Bindings in `WorkerCode.env`, not arbitrary platform binding objects. Confirm any direct pass only in a paid probe; the RPC wrapper avoids relying on that undocumented transfer behavior.

## Tests to add at the seam

- **Model-route unit test (Worker/workerd):** use a fake AI binding that records its arguments. Assert exactly `@cf/zai-org/glm-5.3-flash`, `reasoning_effort: "low"`, structured `messages`, and awaited/normalized result. Assert that caller input cannot override the model ID or effort.
- **Dynamic facet capability test:** load a tiny fixture whose `MainFacet` calls `env.MODEL.run` on `/facet/model`. Assert the fake route receives the request and that `env` contains only `MODEL`; retain `globalOutbound: null` and test that an ambient `fetch()` fails. This replaces the current empty-binding assumption only for the explicitly granted model capability.
- **Supervisor paid/integration probe:** keep the real inference call out of `pnpm verify`; a paid account test should run the `/probe` path separately and retain raw response/error evidence. Test model availability and billing failures as plain route errors without recording a successful relay attempt.
- **Buffered turn test:** verify one complete model response is normalized and saved before the Supervisor relay returns. A 200 response header alone must not earn relay credit; this matches the existing body-completion rule in `src/supervisor/relay/` and ADR-0031.

## Sources

1. [Cloudflare model: glm-5.3-flash](https://developers.cloudflare.com/workers-ai/models/glm-5.3-flash/) — exact model ID, capabilities, paid requirement, usage examples, input parameters including `reasoning_effort`, output schema, and pricing.
2. [Workers AI bindings](https://developers.cloudflare.com/workers-ai/configuration/bindings/) — Wrangler `ai` binding and `env.AI.run()` contract.
3. [Workers and Wrangler getting started](https://developers.cloudflare.com/workers-ai/get-started/workers-wrangler/) — TypeScript `AI: Ai`, response example, `wrangler dev`, and local billing warning.
4. [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/) — paid billing requirement and AI Gateway Unified billing path.
5. [Workers AI limits](https://developers.cloudflare.com/workers-ai/platform/limits/) — current rate-limit categories and per-model limits.
6. [Dynamic Workers getting started](https://developers.cloudflare.com/dynamic-workers/getting-started/) — `LOADER`, `load()`/`get()`, `globalOutbound: null`, and WorkerCode configuration.
7. [Dynamic Workers API reference](https://developers.cloudflare.com/dynamic-workers/api-reference/) — WorkerCode `env` accepts structured-cloneable values and Service Bindings; `globalOutbound` behavior.
8. [Workers RPC](https://developers.cloudflare.com/workers/runtime-apis/rpc/) — awaited RPC and argument/return-value rules.
9. [Durable Object State](https://developers.cloudflare.com/durable-objects/api/state/) — `DurableObjectState.exports` provides loopback bindings to top-level Worker exports, which supports the host-side route injection from `Supervisor`.

## Repository evidence

- `wrangler.jsonc`: no `ai` binding; existing `LOADER` and `MODULE_MAPS` bindings.
- `src/worker.ts`: root fetch currently targets the hard-coded `facet-spike` tenant.
- `src/supervisor/supervisor.ts`: Supervisor environment currently contains only `LOADER`; constructor creates the loaded facet boundary.
- `src/facet/index.ts`: `loadArtifact()` currently passes `env: {}` and `globalOutbound: null` to Worker Loader.
- `src/facet/fixture.ts`: fixture checks and reports dynamic environment binding names.
- `test/facet/facet-spike.test.ts`: currently asserts the facet receives no bindings; update this expectation only when the narrow `MODEL` capability is introduced.
- `test/facet/loader.test.ts`: existing Worker Loader/module-map seam tests are the right place for a capability-injection test.
- `test/supervisor/relay/relay.test.ts`, `src/supervisor/relay/`: existing buffered-body and relay evidence rules should remain unchanged.
- `docs/agents/design/feature-map.md`: P0 requires a model probe and P1 requires one fixed model route whose credential stays outside the mutable facet.
