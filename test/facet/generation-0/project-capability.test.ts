import { expect, test } from "vitest";
import { leaseProjectCapability } from "../../../src/facet/generation-0/project-capability.js";
import { FakeProjectCapability } from "./fake-project-capability.js";
import { makeFacetExecutionEnv } from "./execution-env-target.js";

test("leases a duplicate rather than the received capability", () => {
  const received = FakeProjectCapability.create();
  const lease = leaseProjectCapability(received);

  expect(lease).toBeDefined();
  expect(lease?.capability).not.toBe(received);
  expect(received.ledger.dups).toBe(1);
});

test("releases the duplicate exactly once however many callers ask", () => {
  const received = FakeProjectCapability.create();
  const lease = leaseProjectCapability(received);
  if (lease === undefined) throw new Error("a duplicable capability must lease");

  expect(lease.released).toBe(false);
  lease.release();
  lease.release();
  lease.release();

  expect(lease.released).toBe(true);
  expect(received.ledger.disposals).toBe(1);
});

test("leaves the received capability usable after the lease is released", async () => {
  const received = FakeProjectCapability.create();
  const lease = leaseProjectCapability(received);
  if (lease === undefined) throw new Error("a duplicable capability must lease");

  lease.release();

  expect(() => lease.capability.lstat("/")).toThrow("used after being disposed");
  await expect(received.lstat("/")).resolves.toMatchObject({ ok: true });
});

test("rejects a capability that carries no stub lifetime", () => {
  const { projectTarget } = makeFacetExecutionEnv();

  expect(
    leaseProjectCapability(projectTarget),
    "a locally constructed target has no dup or disposer, so no turn can own it",
  ).toBeUndefined();
});
