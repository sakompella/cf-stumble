import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import type { ConversationHost } from "../../../src/facet/index.js";
import { MainFacet } from "../../../src/facet/generation-1/main-facet.js";
import type { ModelCapability } from "../../../src/facet/generation-1/capabilities.js";

const noModelRun: ModelCapability = {
  runStream: () => Promise.reject(new Error("no run asks the model")),
};

afterEach(async () => {
  await reset();
});

test("an attach after a failed open opens the session and arms the host", async () => {
  let armed = 0;

  const host: ConversationHost & Readonly<{ dup(): ConversationHost }> = {
    arm: () => {
      armed += 1;

      return Promise.resolve();
    },
    running: () => Promise.resolve(),
    workspace: () => Promise.reject(new Error("no workspace")),
    dup: () => host,
  };

  await runInDurableObject(
    env.SUPERVISOR.getByName("main-facet-open"),
    async (_instance, state) => {
      const { storage } = state;
      let failedOnce = false;

      Object.defineProperty(state, "storage", {
        get: () => {
          if (!failedOnce) {
            failedOnce = true;

            throw new Error("the storage is unavailable");
          }

          return storage;
        },
      });
      const facet = new MainFacet(state, { MODEL: noModelRun });

      await expect(facet.attach(host)).rejects.toThrow("the storage is unavailable");
      expect(armed).toBe(0);

      await expect(facet.attach(host)).resolves.toBeUndefined();
      expect(armed).toBeGreaterThan(0);
    },
  );
});
