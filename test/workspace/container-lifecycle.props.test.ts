import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { expect, test } from "vitest";
import { ContainerLifecycle } from "../../src/workspace/container-lifecycle.js";

const STEPS = ["run-1", "run-2", "run-3", undefined, "stop"] as const;

test("the generation counts each connect to a runtime other than the one connected before it", () => {
  hegel.test(
    (tc) => {
      const lifecycle = new ContainerLifecycle();
      let previous: { readonly runtimeId: string | undefined } | undefined;
      let generation = 0;

      for (const step of tc.draw(gs.arrays(gs.sampledFrom(STEPS), { maxSize: 20 }))) {
        if (step === "stop") {
          lifecycle.stoppedByHost();
          previous = undefined;
        } else {
          lifecycle.connected(step);

          if (previous !== undefined && previous.runtimeId !== step) generation += 1;
          previous = { runtimeId: step };
        }

        expect(lifecycle.generation).toBe(generation);
      }
    },
    { testCases: 200 },
  );
});

test("after the Host stops the container on purpose, the next runtime is not a replacement", () => {
  const lifecycle = new ContainerLifecycle();
  lifecycle.connected("run-1");
  lifecycle.stoppedByHost();
  lifecycle.connected("run-2");

  expect(lifecycle.generation, "the first exec after an idle stop must not report a restart").toBe(
    0,
  );

  lifecycle.connected("run-3");
  expect(lifecycle.generation, "a later change still counts").toBe(1);
});
