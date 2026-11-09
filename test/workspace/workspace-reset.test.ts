import * as Effect from "effect/Effect";
import { expect, test } from "vitest";
import { resetWorkspaceStorage } from "../../src/workspace/workspace-reset.js";

test("wipes workspace storage before stopping the container", async () => {
  const events: string[] = [];

  const storage = {
    deleteAll: () => {
      events.push("deleteAll");

      return Promise.resolve();
    },
  };

  const stopContainer = Effect.sync(() => {
    events.push("stop");
  });

  await expect(Effect.runPromise(resetWorkspaceStorage(storage, stopContainer))).resolves.toEqual({
    ok: true,
    reset: "workspace",
  });
  expect(events).toEqual(["deleteAll", "stop"]);
});
