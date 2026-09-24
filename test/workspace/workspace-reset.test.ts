import type {
  ContainerLaunchSpec,
  ContainerRuntimeInfo,
} from "@cloudflare/computer/backends/container";
import { expect, test } from "vitest";
import { resetWorkspaceStorage } from "../../src/workspace/host.js";

test("wipes workspace storage before restarting the container", async () => {
  const events: string[] = [];

  const storage = {
    deleteAll: () => {
      events.push("deleteAll");

      return Promise.resolve();
    },
  };

  const container = {
    restart: (spec: ContainerLaunchSpec): Promise<ContainerRuntimeInfo> => {
      events.push("restart");
      expect(spec).toEqual({
        env: { PORT: "8080", MOUNT_POINT: "/workspace" },
        enableInternet: true,
      });

      return Promise.resolve({
        runtimeId: "reset-runtime",
        clientSecret: "secret",
        outcome: "launched",
      });
    },
  };

  await expect(resetWorkspaceStorage(storage, container)).resolves.toEqual({
    ok: true,
    reset: "workspace",
  });
  expect(events).toEqual(["deleteAll", "restart"]);
});
