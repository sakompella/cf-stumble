# E7 — The streaming plumbing exists; exactly one await collapses it

Status: CONFIRMED by the root agent. Scopes goal criterion 4 down.
Refines E5 and roadmap task T4. This is GOOD news for the plan.

## What already streams

- `src/facet/index.ts` — `MainFacetTarget.startTurn(...): ReadableStream<Uint8Array>`.
  The facet boundary is a stream by contract.
- `@cf-stumble/pi` exports `createAssistantMessageEventStream()` and
  `AssistantMessageEventStream`. Pi's incremental event type is available and in use.

## Where it collapses

`src/facet/generation-0/route-stream.ts`, `streamOnce`:

```ts
response = await model.run(request);          // whole reply, one await
...
const assistant = routeResponseToPiAssistant(response);
// a fresh AssistantMessageEventStream is created and the FINISHED message is pushed into it
```

The adapter awaits the complete model reply, converts it, and pushes it into a Pi event
stream as a single event. It is a stream of one. `endedStream`/`failedStream` do the same
for the error paths.

This is the mechanism behind the critique's "the model route buffers output". Combined
with E5 — `ModelInference.run` returns `Promise<ProviderResult>`, one finished message —
the non-incremental part of the system is exactly two hops: the route interface and this
adapter.

## Why this matters for sizing T4

T4 does NOT have to invent streaming through the facet, the page transport, or Pi. Those
exist. It must:

1. Give the model route an incremental interface (Workers AI supports `stream: true`), and
2. Push deltas into the `AssistantMessageEventStream` in `streamOnce` instead of one push.

That is a narrow, well-located change at a real seam, not a cross-cutting rewrite. If the
roadmap sized T4 as large because of the critique's wording, re-check it against this.

## Caveat that keeps T4 honest

`ROUTE_MODEL` declares `contextWindow: 0`, `maxTokens: 0`, `cost: 0`, `reasoning: false`,
with the comment "Generation 0 has no way to learn the real values and must not invent
them". Compaction (T7) reads context-window numbers. A zero context window may make Pi's
compaction trigger meaningless. T7 must confirm what Pi does with a zero window before it
claims a forced-compaction test passes (goal criterion 5).
