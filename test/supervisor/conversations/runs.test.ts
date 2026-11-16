import { reset, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, expect, test, vi } from "vitest";
import { runAtEntryPoint } from "../../../src/run-entry-point.js";
import { ConversationRuns } from "../../../src/supervisor/conversations/runs.js";

afterEach(async () => {
  await reset();
});

test("a failing alarm write rejects the entry point that asked for it", async () => {
  await runInDurableObject(
    env.SUPERVISOR.getByName("runs-alarm-write-failed"),
    (_instance, state) => {
      vi.spyOn(state.storage, "deleteAlarm").mockRejectedValue(new Error("the storage refused"));

      const runs = new ConversationRuns(state.storage);

      return expect(runAtEntryPoint(runs.setAlarm(0))).rejects.toThrow("the storage refused");
    },
  );
});
