import { expect, test } from "vitest";
import { handleGeneration0Request } from "../../../src/facet/generation-0/index.js";

function startupRequest(): Request {
  return new Request("https://main-facet.invalid/");
}

test("GET / answers cheaply and deterministically without using a capability", async () => {
  const first = await handleGeneration0Request(startupRequest());
  const second = await handleGeneration0Request(startupRequest());
  const body = await first.text();

  expect(first.status).toBe(200);
  expect(body).toBe("generation-0 main facet ready");
  expect(body.length, "the startup check bounds the body at 1024 bytes").toBeLessThan(1_024);
  expect(await second.text()).toBe(body);
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
