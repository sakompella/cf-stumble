import { env } from "cloudflare:workers";
import { expect, test } from "vitest";

test("a Supervisor reached by id refuses to construct", async () => {
  const stub = env.SUPERVISOR.get(env.SUPERVISOR.newUniqueId());

  await expect(stub.fetch("https://supervisor.invalid/")).rejects.toThrow(
    "a Supervisor must be reached by name, not by id",
  );
}, 30_000);

test("a Supervisor reached by name serves", async () => {
  const stub = env.SUPERVISOR.getByName("named-supervisor");

  const response = await stub.fetch("https://supervisor.invalid/");

  expect(response.status).not.toBe(500);
}, 30_000);
