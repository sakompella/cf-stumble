import { env } from "cloudflare:workers";
import { expect, test } from "vitest";

/**
 * The Supervisor's one workspace is named from the Supervisor's own name, and that name comes from
 * a verified Access identity. A stub obtained from a raw id carries no such name, so construction
 * must fail rather than name a workspace from the id.
 */
test("a Supervisor reached by id refuses to construct", async () => {
  const stub = env.SUPERVISOR.get(env.SUPERVISOR.newUniqueId());

  await expect(stub.fetch("https://supervisor.invalid/")).rejects.toThrow(
    "a Supervisor must be reached by name, not by id",
  );
});

test("a Supervisor reached by name serves", async () => {
  const stub = env.SUPERVISOR.getByName("named-supervisor");

  const response = await stub.fetch("https://supervisor.invalid/");

  expect(response.status).not.toBe(500);
});
