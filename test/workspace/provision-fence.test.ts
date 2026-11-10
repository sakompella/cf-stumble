import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { expect, test } from "vitest";
import { ProvisionFence } from "../../src/supervisor/readiness/provision-fence.js";
import { sampleProjectOne } from "../project-fixtures.js";

const admitted = (fence: ProvisionFence) =>
  Effect.runPromise(
    fence.wait(sampleProjectOne.id).pipe(
      Effect.as(true),
      Effect.timeoutOrElse({ duration: 50, orElse: () => Effect.succeed(false) }),
    ),
  );

test("a provision in one fence does not hold the same project in another fence", async () => {
  const first = new ProvisionFence();
  const second = new ProvisionFence();
  const running = Effect.runFork(first.provision(sampleProjectOne.id, Effect.never));

  expect(await admitted(first)).toBe(false);
  expect(await admitted(second)).toBe(true);

  await Effect.runPromise(Fiber.interrupt(running));
});
