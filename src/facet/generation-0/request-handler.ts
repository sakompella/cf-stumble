/** Reads no capability, so a passing check proves request handling started, not that a model or workspace answered. */
const READY_BODY = "generation-0 main facet ready";

/** A turn is not a request: `MainFacet.startTurn` is an RPC method because it must receive a capability that cannot be serialized into a request. */
export function handleGeneration0Request(request: Request): Promise<Response> {
  const path = new URL(request.url).pathname;

  if (path === "/") {
    return Promise.resolve(new Response(READY_BODY));
  }

  return Promise.resolve(new Response("Not found", { status: 404 }));
}
