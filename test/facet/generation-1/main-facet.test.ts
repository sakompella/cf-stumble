import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { Harness } from "@earendil-works/pi-durable";
import { afterEach, expect, test, vi } from "vitest";
import { MainFacet } from "../../../src/facet/generation-1/main-facet.js";
import type { ModelCapability } from "../../../src/facet/conversation-protocol.js";
import { capacityOnceModel } from "./scripted-route.js";
import { eventually } from "../../eventually.js";
import { unscriptedGenerations } from "./generation-control.js";
import { entriesText, hostWith } from "./conversation-host.js";

const noModelRun: ModelCapability = {
  runStream: () => Promise.reject(new Error("no run asks the model")),
};

const refusingModel: ModelCapability = {
  runStream: () =>
    Promise.resolve({
      ok: false,
      error: { code: "invalid-request", reason: "messages must be a non-empty array" },
    }),
};

afterEach(async () => {
  vi.useRealTimers();
  await reset();
});

test("an attach after a failed open opens the session and arms the host", async () => {
  let armed = 0;

  const host = hostWith({
    arm: () => {
      armed += 1;

      return Promise.resolve();
    },
  });

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
      const facet = new MainFacet(state, env);

      await expect(facet.attach(host, noModelRun, unscriptedGenerations)).rejects.toThrow(
        "the storage is unavailable",
      );
      expect(armed).toBe(0);

      await expect(facet.attach(host, noModelRun, unscriptedGenerations)).resolves.toBeUndefined();
      expect(armed).toBeGreaterThan(0);
    },
  );
});

test("an idle events stream beats every two seconds, and cancelling it leaves no timer running", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });

  const host = hostWith();

  await runInDurableObject(
    env.SUPERVISOR.getByName("main-facet-events"),
    async (_instance, state) => {
      const facet = new MainFacet(state, env);

      await facet.attach(host, noModelRun, unscriptedGenerations);

      const id = await facet.createConversation("/workspace");
      const reader = (await facet.events(id)).getReader();

      await reader.read();
      expect(vi.getTimerCount()).toBe(1);

      const beat = reader.read();

      await vi.advanceTimersByTimeAsync(2_000);
      expect(new TextDecoder().decode((await beat).value)).toBe("\n");

      await reader.cancel();
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});

test("a session that failed on a storage error is reopened by the next attach and reported to the host", async () => {
  const faults: string[] = [];
  let opened = 0;

  const host = hostWith({
    log: (level, event, fields) => {
      if (level === "error" && event === "session-failed")
        faults.push(`${event}: ${String(fields["cause"])}`);

      return Promise.resolve();
    },
    running: () => {
      opened += 1;

      return Promise.resolve();
    },
  });

  await runInDurableObject(
    env.SUPERVISOR.getByName("main-facet-failed"),
    async (_instance, state) => {
      const exec = state.storage.sql.exec.bind(state.storage.sql);
      let broken = false;

      vi.spyOn(state.storage.sql, "exec").mockImplementation((...args) => {
        if (broken) throw new Error("storage reset");

        return exec(...args);
      });
      const facet = new MainFacet(state, env);

      await facet.attach(host, noModelRun, unscriptedGenerations);
      expect(opened).toBe(1);

      broken = true;
      await expect(facet.createConversation("/workspace")).rejects.toThrow("storage reset");
      await eventually(() => {
        expect(faults.length).toBe(1);
      });
      expect(faults[0]).toContain("storage reset");

      broken = false;
      await facet.attach(host, noModelRun, unscriptedGenerations);
      expect(opened).toBe(2);
      await expect(facet.createConversation("/workspace")).resolves.toBeTypeOf("string");
    },
  );
});

test("a turn whose model fails is reported to the host as failed with the reason", async () => {
  const reports: Array<Readonly<Record<string, string>> | undefined> = [];

  const host = hostWith({
    running: (_conversations, failed) => {
      reports.push(failed);

      return Promise.resolve();
    },
  });

  await runInDurableObject(
    env.SUPERVISOR.getByName("main-facet-turn-failed"),
    async (_instance, state) => {
      const facet = new MainFacet(state, env);

      await facet.attach(host, refusingModel, unscriptedGenerations);

      const id = await facet.createConversation("/workspace");

      await facet.submit(id, "hello", "r1");
      await eventually(() => {
        expect(reports).toContainEqual({ [id]: "model_error" });
      });
    },
  );
});

test("a host that refuses the first running report aborts the facet", async () => {
  const host = hostWith({ running: () => Promise.reject(new Error("supervisor gone")) });

  await runInDurableObject(
    env.SUPERVISOR.getByName("main-facet-first-report"),
    async (_instance, state) => {
      const aborted = vi.spyOn(state, "abort").mockImplementation(() => {});
      const facet = new MainFacet(state, env);

      await expect(facet.attach(host, noModelRun, unscriptedGenerations)).rejects.toThrow(
        "supervisor gone",
      );
      expect(aborted).toHaveBeenCalledTimes(1);
    },
  );
});

test("a submit that fails leaves the host armed with the plain wake, not the active one (issue #10, 11bdd393)", async () => {
  const arms: unknown[] = [];

  const host = hostWith({
    arm: (wake) => {
      arms.push(wake);

      return Promise.resolve();
    },
  });

  const open = Harness.open.bind(Harness);

  vi.spyOn(Harness, "open").mockImplementation(async (...args) => {
    const harness = await open(...args);
    const conversation = harness.conversation.bind(harness);

    vi.spyOn(harness, "conversation").mockImplementation(async (...lookup) => {
      const found = await conversation(...lookup);

      if (found !== undefined) vi.spyOn(found, "submit").mockRejectedValue(new Error("busy"));

      return found;
    });

    return harness;
  });

  await runInDurableObject(
    env.SUPERVISOR.getByName("main-facet-failed-submit"),
    async (_instance, state) => {
      const facet = new MainFacet(state, env);

      await facet.attach(host, noModelRun, unscriptedGenerations);
      const id = await facet.createConversation("/workspace");

      await expect(facet.submit(id, "hello", "r1")).rejects.toThrow("busy");
      await eventually(() => {
        expect(arms.at(-1)).not.toMatchObject({ active: true });
      });
      expect(arms).toContainEqual(expect.objectContaining({ active: true }));
    },
  );
});

test("a Workers AI capacity error (3040) is retried by Pi and the turn answers (e2e c6cead13, 24324e53)", async () => {
  const calls: number[] = [];
  const reports: Array<Readonly<Record<string, string>> | undefined> = [];
  let alarm: (() => void) | undefined;

  const host = hostWith({
    arm: ({ at }) => {
      if (at !== undefined) setTimeout(() => alarm?.(), Math.max(0, at - Date.now()));

      return Promise.resolve();
    },
    running: (_conversations, failed) => {
      reports.push(failed);

      return Promise.resolve();
    },
  });

  await runInDurableObject(
    env.SUPERVISOR.getByName("main-facet-3040"),
    async (_instance, state) => {
      const facet = new MainFacet(state, env);
      const model = capacityOnceModel(calls);

      alarm = () => void facet.attach(host, model, unscriptedGenerations);
      await facet.attach(host, model, unscriptedGenerations);
      const id = await facet.createConversation("/workspace");

      await facet.submit(id, "hello", "r1");
      await eventually(async () => {
        expect(calls).toHaveLength(2);
        expect(await entriesText(facet, id)).toContain('"hi"');
      });
      expect(reports.flatMap((failed) => Object.values(failed ?? {}))).not.toContain("model_error");
    },
  );
}, 15_000);
