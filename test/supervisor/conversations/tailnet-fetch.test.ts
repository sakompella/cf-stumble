import { expect, test, vi } from "vitest";
import { GENERATION_REPLACED } from "../../../src/generation-replaced.js";
import { servingHosts } from "../../../src/supervisor/conversations/host-target.js";
import { tailnetFetchOf } from "../../../src/supervisor/conversations/tailnet-fetch.js";

const reached = vi.fn<() => never>();

const UNREACHED_PORTS = {
  arm: reached,
  log: reached,
  running: reached,
  workspace: reached,
  tailnetFetch: reached,
};

const UNREACHED_GENERATIONS = {
  getActiveGeneration: reached,
  submitGeneration: reached,
  prepareGeneration: reached,
  controlGeneration: reached,
};

function hostServing(
  tailnetFetch: (url: string, init?: RequestInit) => Promise<Response>,
  serves: () => boolean,
) {
  return servingHosts({ ...UNREACHED_PORTS, tailnetFetch }, UNREACHED_GENERATIONS, serves).host;
}

test("the host a facet holds forwards a tailnet fetch to the Supervisor's tailnet fetch", async () => {
  const forwarded = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(() =>
    Promise.resolve(new Response("pong", { status: 202 })),
  );

  const response = await hostServing(forwarded, () => true).tailnetFetch("http://100.64.0.7/ping", {
    method: "POST",
    body: "ping",
  });

  expect(forwarded).toHaveBeenCalledWith("http://100.64.0.7/ping", {
    method: "POST",
    body: "ping",
  });
  expect(response.status).toBe(202);
  expect(await response.text()).toBe("pong");
});

test("the host refuses a tailnet fetch that is not a url string and request options", async () => {
  const forwarded = vi.fn<() => Promise<Response>>();
  const host = hostServing(forwarded, () => true);
  const untyped: { tailnetFetch(...args: unknown[]): Promise<Response> } = host;

  await expect(untyped.tailnetFetch(7)).rejects.toThrow("a tailnet fetch");
  await expect(untyped.tailnetFetch("http://100.64.0.7/", "GET")).rejects.toThrow(
    "a tailnet fetch",
  );
  expect(forwarded).not.toHaveBeenCalled();
});

test("a replaced serving instance's tailnet fetch is refused without reaching the Supervisor", async () => {
  const forwarded = vi.fn<() => Promise<Response>>();

  await expect(
    hostServing(forwarded, () => false).tailnetFetch("http://100.64.0.7/"),
  ).rejects.toThrow(GENERATION_REPLACED);
  expect(forwarded).not.toHaveBeenCalled();
});

test("a tailnet fetch goes to the TAILNET binding as one Request", async () => {
  const received: Request[] = [];

  const tailnet = {
    fetch: (request: Request) => {
      received.push(request);

      return Promise.resolve(new Response("up"));
    },
  };

  const response = await tailnetFetchOf(tailnet)("http://100.64.0.7/status", {
    method: "PUT",
    headers: { "x-probe": "1" },
    body: "body",
  });

  const [request] = received;

  expect(request?.url).toBe("http://100.64.0.7/status");
  expect(request?.method).toBe("PUT");
  expect(request?.headers.get("x-probe")).toBe("1");
  expect(await request?.text()).toBe("body");
  expect(await response.text()).toBe("up");
});

test("a tailnet fetch rejects when the deployment has no TAILNET binding", async () => {
  await expect(tailnetFetchOf()("http://100.64.0.7/")).rejects.toThrow("no tailnet");
});
