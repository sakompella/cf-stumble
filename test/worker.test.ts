import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import worker from "../src/worker.js";

test("a request with no credential reaches the Supervisor and reads the status", async () => {
  const response = await worker.fetch(new Request("https://cf-stumble.test/api/status"), env);

  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  await expect(response.json()).resolves.toEqual({
    activeGeneration: { generation: null, epoch: 0 },
  });
});
