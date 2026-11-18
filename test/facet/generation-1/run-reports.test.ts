import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness } from "@earendil-works/pi-durable";
import { afterEach, expect, test, vi } from "vitest";
import { MainFacet } from "../../../src/facet/generation-1/main-facet.js";
import type { ModelCapability, RunFailures } from "../../../src/facet/conversation-protocol.js";
import { eventually } from "../../eventually.js";
import { unscriptedGenerations } from "./generation-control.js";
import { hostWith } from "./conversation-host.js";

const refusingModel: ModelCapability = {
  runStream: () =>
    Promise.resolve({
      ok: false,
      error: { code: "invalid-request", reason: "messages must be a non-empty array" },
    }),
};

afterEach(async () => {
  await reset();
});

test("a run failure is reported by the facet's next session when the host refused the reports of that run", async () => {
  const opened: Harness[] = [];
  const open = Harness.open.bind(Harness);

  vi.spyOn(Harness, "open").mockImplementation(async (...args) => {
    const harness = await open(...args);
    opened.push(harness);

    return harness;
  });

  const refusing = hostWith({
    running: (running, failed = {}) =>
      running.length === 0 && Object.keys(failed).length === 0
        ? Promise.resolve()
        : Promise.reject(new Error("the Supervisor restarted")),
  });

  const reports: RunFailures[] = [];

  const recording = hostWith({
    running: (_running, failed = {}) => {
      reports.push(failed);

      return Promise.resolve();
    },
  });

  await runInDurableObject(
    env.SUPERVISOR.getByName("run-reports-lost-failure"),
    async (_instance, state) => {
      const aborted = vi.spyOn(state, "abort").mockImplementation(() => {});
      const lost = new MainFacet(state, env);

      await lost.attach(refusing, refusingModel, unscriptedGenerations);
      const id = await lost.createConversation("/workspace");
      await lost.submit(id, "hello", "r1");
      await eventually(() => {
        expect(aborted).toHaveBeenCalled();
      });
      await opened[0]?.close(BACKGROUND_CONTEXT);

      await new MainFacet(state, env).attach(recording, refusingModel, unscriptedGenerations);

      expect(reports[0]).toEqual({ [id]: "model_error" });
    },
  );
});
