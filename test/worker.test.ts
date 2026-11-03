import { env } from "cloudflare:workers";
import { afterEach, expect, test, vi } from "vitest";
import worker from "../src/worker.js";

const ORIGIN = "https://cf-stumble.test";

afterEach(() => {
  vi.restoreAllMocks();
});

test("a request reaches the Supervisor and reads the status", async () => {
  const response = await worker.fetch(new Request(`${ORIGIN}/api/status`), env);

  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  await expect(response.json()).resolves.toEqual({
    activeGeneration: { generation: null, epoch: 0 },
  });
});

test("a POST from another origin is refused before the Supervisor, and one from its own origin or with no Origin is routed", async () => {
  const getByName = vi.spyOn(env.SUPERVISOR, "getByName");

  const post = (origin?: string) =>
    worker.fetch(
      new Request(`${ORIGIN}/api/unknown`, {
        method: "POST",
        headers: origin === undefined ? {} : { origin },
      }),
      env,
    );

  const foreign = await post("https://elsewhere.test");

  expect(foreign.status).toBe(403);
  expect(foreign.headers.get("cache-control")).toBe("no-store");
  await expect(foreign.json()).resolves.toEqual({
    ok: false,
    error: { code: "cross-origin-request" },
  });
  expect(getByName).not.toHaveBeenCalled();
  expect((await post(ORIGIN)).status).toBe(404);
  expect((await post()).status).toBe(404);
  expect(getByName).toHaveBeenCalledTimes(2);
});
