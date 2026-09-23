/// <reference types="@cloudflare/vitest-plugin/types" />

import { reset } from "cloudflare:test";
import { afterEach, expect, test, vi } from "vitest";
import { activeSupervisor } from "../helpers.js";

function relayRequest(path: string, init?: RequestInit): Request {
  return new Request(`https://cf-stumble.test${path}`, init);
}

afterEach(async () => {
  await reset();
});

test("relays an ordinary request and response without changing either side", async () => {
  const control = await activeSupervisor("relay-preserves-http");

  const response = await control.fetch(
    relayRequest("/facet/relay/echo?query=preserved", {
      method: "POST",
      headers: { "x-request-header": "request header" },
      body: "request body",
    }),
  );

  expect(response.status).toBe(201);
  expect(response.headers.get("x-facet-method")).toBe("POST");
  expect(response.headers.get("x-facet-path")).toBe("/facet/relay/echo");
  expect(response.headers.get("x-facet-request-header")).toBe("request header");
  expect(response.headers.get("x-facet-response-header")).toBe("preserved");
  expect(await response.text()).toBe("request body");
});

test("answers 502 when the generation fails before its response headers", async () => {
  const control = await activeSupervisor("relay-pre-header-failure");
  const response = await control.fetch(relayRequest("/facet/relay/pre-header-failure"));

  expect(response.status).toBe(502);
});

/**
 * The public 502 tells a caller nothing, on purpose: a broken generation and a Loader or RPC
 * transport failure must look identical to the caller. An operator still needs to tell them
 * apart, so the discarded cause must reach a log, redacted, without changing the response at all.
 */
test("logs the discarded cause of a pre-header failure without changing the public 502", async () => {
  const control = await activeSupervisor("relay-pre-header-failure");
  const loggedErrors = vi.spyOn(console, "error").mockImplementation(() => {});

  const response = await control.fetch(relayRequest("/facet/relay/pre-header-failure"));

  expect(response.status).toBe(502);
  expect(await response.text()).toBe("Main facet failed before response headers");
  expect(loggedErrors, "the discarded cause must reach an operator log").toHaveBeenCalledTimes(1);
  const logged = loggedErrors.mock.calls[0]?.join(" ") ?? "";
  expect(logged).toContain("facet failed before headers");

  loggedErrors.mockRestore();
});
