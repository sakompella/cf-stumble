import { env } from "cloudflare:workers";
import { expect, test } from "vitest";

test("a Supervisor reached by name serves", async () => {
  const stub = env.SUPERVISOR.getByName("named-supervisor");

  await expect(stub.getActiveGeneration()).resolves.toEqual({ generation: undefined, epoch: 0 });
}, 30_000);
