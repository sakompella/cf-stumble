import type {
  ModelRouteRequest,
  ModelRouteResponse,
  ValidationFailure,
} from "../../model-route.js";

/**
 * The model capability the host hands a Generation 0 facet. It carries messages and tools only:
 * the immutable `src/model-route.ts` owns the model, the reasoning effort, the endpoint, and the
 * credential, so nothing in this generation can select or override them.
 *
 * `runStream` is the path a turn runs on: `./route-stream.ts` drives Pi's `Agent` from it, and it
 * answers with incremental events (E5, E7) rather than one finished message. `run` is the host
 * route's buffered method, declared here because this type must stay exactly the capability the
 * host installs — `test/facet/loader-environment.test.ts` checks that — not because this
 * generation calls it. Both resolve a `Promise` because this capability crosses a Worker RPC hop
 * (every call is async there, whatever the callee's own method declares); once the promise
 * resolves, `runStream`'s `ReadableStream` still yields events as they arrive rather than after
 * the whole turn finishes, matching `MainFacetTarget`'s own `startTurn` contract.
 */
export type ModelCapability = Readonly<{
  run(request: ModelRouteRequest): Promise<ModelRouteResponse | ValidationFailure>;
  runStream(request: ModelRouteRequest): Promise<ReadableStream<Uint8Array> | ValidationFailure>;
}>;

/**
 * Everything a Generation 0 facet's environment holds. Capabilities only: no raw binding, no
 * credential, no model name, no reasoning level, and no thread store, because the conversation
 * arrives as an argument of one turn and leaves in that turn's terminal frame.
 *
 * Only a generation-invariant capability belongs here, so this is exactly `MainFacetCapabilities`,
 * the type the host installs. `test/facet/loader-environment.test.ts` checks that the two agree,
 * which is what keeps a per-project capability from acquiring a slot here.
 */
export type Generation0Capabilities = Readonly<{
  MODEL: ModelCapability;
}>;
