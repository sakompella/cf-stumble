import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, test, vi } from "vitest";
import type { ConversationHost } from "../../../src/facet/index.js";
import { MainFacet } from "../../../src/facet/generation-1/main-facet.js";
import type { ModelCapability } from "../../../src/facet/generation-1/capabilities.js";

const noModelRun: ModelCapability = {
  runStream: () => Promise.reject(new Error("no run asks the model")),
};

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

test("an attach after a failed open opens the session and arms the host", async () => {
  let armed = 0;

  const host: ConversationHost & Readonly<{ dup(): ConversationHost }> = {
    fault: () => Promise.resolve(),
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

test("a reader that stops consuming holds the watch back, and cancelling stops the keepalive", async () => {
  const host: ConversationHost & Readonly<{ dup(): ConversationHost }> = {
    arm: () => Promise.resolve(),
    fault: () => Promise.resolve(),
    running: () => Promise.resolve(),
    workspace: () => Promise.reject(new Error("no workspace")),
    dup: () => host,
  };

  await runInDurableObject(
    env.SUPERVISOR.getByName("main-facet-events"),
    async (_instance, state) => {
      const facet = new MainFacet(state, { MODEL: noModelRun });

      await facet.attach(host);

      const id = await facet.createConversation("/workspace");
      const events = await facet.events(id);
      const reader = events.getReader();
      const cleared = vi.spyOn(globalThis, "clearInterval");

      await reader.read();

      for (let turn = 0; turn < 5; turn += 1) {
        await facet.submit(id, `message ${turn}`, `r${turn}`);
      }

      await reader.cancel();
      await vi.waitFor(() => {
        expect(cleared).toHaveBeenCalled();
      });
    },
  );
});

test("a session that failed on a storage error is reopened by the next attach and reported to the host", async () => {
  const faults: string[] = [];
  let opened = 0;

  const host: ConversationHost & Readonly<{ dup(): ConversationHost }> = {
    arm: () => Promise.resolve(),
    fault: (event, detail) => {
      faults.push(`${event}: ${detail}`);

      return Promise.resolve();
    },
    running: () => {
      opened += 1;

      return Promise.resolve();
    },
    workspace: () => Promise.reject(new Error("no workspace")),
    dup: () => host,
  };

  await runInDurableObject(
    env.SUPERVISOR.getByName("main-facet-failed"),
    async (_instance, state) => {
      const exec = state.storage.sql.exec.bind(state.storage.sql);
      let broken = false;

      vi.spyOn(state.storage.sql, "exec").mockImplementation((...args) => {
        if (broken) throw new Error("storage reset");

        return exec(...args);
      });
      const facet = new MainFacet(state, { MODEL: noModelRun });

      await facet.attach(host);
      expect(opened).toBe(1);

      broken = true;
      await expect(facet.createConversation("/workspace")).rejects.toThrow();
      await vi.waitFor(() => {
        expect(faults.length).toBe(1);
      });
      expect(faults[0]).toContain("storage reset");

      broken = false;
      await facet.attach(host);
      expect(opened).toBe(2);
      await expect(facet.createConversation("/workspace")).resolves.toBeTypeOf("string");
    },
  );
});
