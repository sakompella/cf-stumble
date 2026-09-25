import { expect, test } from "vitest";
import { handleGeneration0Request } from "../../../src/facet/generation-0/index.js";

function startupRequest(): Request {
  return new Request("https://main-facet.invalid/");
}

test("GET / answers with the startup message without using a capability", async () => {
  const response = await handleGeneration0Request(startupRequest());
  const body = await response.text();

  expect(response.status).toBe(200);
  expect(body).toBe("generation-0 main facet ready");
});

/**
 * A turn is not a request. It arrives as `MainFacet.startTurn`, so the buffered `POST /turn` this
 * facet once served is gone rather than kept as an unused second definition of a turn: whatever
 * method it is asked with, the path is simply not found.
 */
test("the turn path is gone, and nothing else is served", async () => {
  for (const request of [
    new Request("https://main-facet.invalid/turn", { method: "POST", body: "{}" }),
    new Request("https://main-facet.invalid/turn"),
    new Request("https://main-facet.invalid/facet/model"),
  ]) {
    const response = await handleGeneration0Request(request);
    expect(response.status, `${request.method} ${new URL(request.url).pathname}`).toBe(404);
  }
});
