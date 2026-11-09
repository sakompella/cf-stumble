import { afterEach, expect, test, vi } from "vitest";
import { WORKSPACE_IDLE_STOP_MS } from "../../src/workspace/idle-stop.js";
import { REFUSED_BUILD, restoreWorkspaceMembers } from "./host-fixtures.js";
import { withHost } from "./idle-host.js";

afterEach(() => {
  vi.restoreAllMocks();
  restoreWorkspaceMembers();
});

const tick = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 20);
  });

test.each(["stops", "fails"] as const)(
  "a reset during an idle stop that %s waits for it, then wipes the store and stops the container for the reset",
  async (outcome) => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    const seen = await withHost(`host-reset-during-idle-${outcome}`, async (host, state, box) => {
      const gate = {
        settle: (): void => {},
      };

      box.destroyGate = new Promise<void>((resolve, reject) => {
        gate.settle =
          outcome === "stops"
            ? resolve
            : () => {
                reject(new Error("destroy failed"));
              };
      });
      await host.build(REFUSED_BUILD);
      await state.storage.put("durable-row", "kept");
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + WORKSPACE_IDLE_STOP_MS + 1_000);

      const alarm = host.alarm();
      await tick();
      let answer: unknown;

      const resetting = host.reset().then((result) => {
        answer = result;
      });

      await tick();

      const during = {
        answered: answer !== undefined,
        row: await state.storage.get("durable-row"),
        destroyed: [...box.destroyed],
      };

      gate.settle();
      await alarm;
      await resetting;

      return {
        during,
        answer,
        row: await state.storage.get("durable-row"),
        destroyed: box.destroyed,
      };
    });

    expect(seen.during, "the reset waits for the idle stop").toEqual({
      answered: false,
      row: "kept",
      destroyed: ["idle"],
    });
    expect(seen.answer).toEqual({ ok: true, reset: "workspace" });
    expect(seen.row).toBeUndefined();
    expect(seen.destroyed).toEqual(outcome === "stops" ? ["idle"] : ["idle", "reset"]);
  },
);
