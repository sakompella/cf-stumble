import { env } from "cloudflare:workers";
import { expect, test } from "vitest";

test("a Supervisor reached by id refuses to construct", async () => {
  const stub = env.SUPERVISOR.get(env.SUPERVISOR.newUniqueId());

  await expect(stub.getActiveGeneration()).rejects.toThrow(
    "a Supervisor must be reached by name, not by id",
  );
}, 30_000);

test("a Supervisor reached by name serves", async () => {
  const stub = env.SUPERVISOR.getByName("named-supervisor");

  await expect(stub.getActiveGeneration()).resolves.toEqual({ generation: undefined, epoch: 0 });
}, 30_000);
