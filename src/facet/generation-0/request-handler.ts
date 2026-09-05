/// <reference types="@cloudflare/workers-types" />

/**
 * The startup-check response (ADR-0029). `GET /` is an ordinary request that must stay cheap and
 * deterministic: it reads no capability, so a passing check proves this generation's request
 * handling started rather than that a model or a workspace answered.
 */
const READY_BODY = "generation-0 main facet ready";

/**
 * The whole request surface of a Generation 0 facet: the startup check, and nothing else.
 *
 * A turn is not a request here. It arrives as `MainFacet.startTurn`, a Durable Object RPC method,
 * because it must receive a project capability that cannot be serialized into a request and must
 * answer with frames while it runs (ADR-0037). There is therefore no `POST /turn`: a second,
 * buffered definition of a turn would be a second answer to the question the streamed turn already
 * answers.
 */
export function handleGeneration0Request(request: Request): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (path === "/") {
    return Promise.resolve(new Response(READY_BODY));
  }

  return Promise.resolve(new Response("Not found", { status: 404 }));
}
