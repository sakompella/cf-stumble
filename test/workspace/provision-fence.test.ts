import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { expect, test } from "vitest";
import { ProvisionFence } from "../../src/supervisor/readiness/provision-fence.js";
import { sampleProjectOne } from "../project-fixtures.js";
import { eventually, tick } from "../eventually.js";

function admission(fence: ProvisionFence) {
  const state = { admitted: false };

  void Effect.runPromise(fence.wait(sampleProjectOne.id)).then(() => {
    state.admitted = true;
  });

  return state;
}

test("a provision in one fence does not hold the same project in another fence", async () => {
  const first = new ProvisionFence();
  const second = new ProvisionFence();
  const running = Effect.runFork(first.provision(sampleProjectOne.id, Effect.never));
  const held = admission(first);
  const free = admission(second);

  await eventually(() => {
    expect(free.admitted).toBe(true);
  });
  await tick();

  expect(held.admitted).toBe(false);

  await Effect.runPromise(Fiber.interrupt(running));
});
