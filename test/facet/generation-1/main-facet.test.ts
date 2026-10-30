/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import type { ConversationHost } from "../../../src/facet/index.js";
import { MainFacet } from "../../../src/facet/generation-1/main-facet.js";
import type { ModelCapability } from "../../../src/facet/generation-1/capabilities.js";

afterEach(async () => {
  await reset();
});

test("an attach after a failed open opens the session again", async () => {
  let opens = 0;

  const storage = new Proxy(
    {},
    {
      get: () => {
        opens += 1;

        throw new Error("the storage is unavailable");
      },
    },
  );

  const host: ConversationHost & Readonly<{ dup(): ConversationHost }> = {
    arm: () => Promise.resolve(),
    workspace: () => Promise.reject(new Error("no workspace")),
    dup: () => host,
  };

  await runInDurableObject(
    env.SUPERVISOR.getByName("main-facet-open"),
    async (_instance, state) => {
      Object.defineProperty(state, "storage", { value: storage });
      // SAFETY: the model route is reached only when a run asks the model, and none runs here.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      const facet = new MainFacet(state, { MODEL: {} as ModelCapability });

      await expect(facet.attach(host)).rejects.toThrow("the storage is unavailable");
      const afterFirst = opens;

      await expect(facet.attach(host)).rejects.toThrow("the storage is unavailable");
      expect(opens).toBeGreaterThan(afterFirst);
    },
  );
});
