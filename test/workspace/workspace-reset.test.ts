import type {
  ContainerLaunchSpec,
  ContainerRuntimeInfo,
} from "@cloudflare/computer/backends/container";
import { afterEach, expect, test, vi } from "vitest";
import { resetWorkspaceStorage } from "../../src/workspace/host.js";
import { routeOwnerApiRequest } from "../../src/routes/index.js";
import { capturedEvents, named } from "../log-capture.js";
import { ownerApiSupervisor, ownerScope } from "../routes/helpers.js";

afterEach(() => {
  vi.restoreAllMocks();
});

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

test("a reset logs each step with its duration, and nothing the container answered", async () => {
  const events = capturedEvents();

  await resetWorkspaceStorage(
    { deleteAll: () => Promise.resolve() },
    {
      restart: () =>
        Promise.resolve({
          runtimeId: "reset-runtime",
          clientSecret: "secret",
          outcome: "launched",
        }),
    },
  );

  const steps = named(events(), "workspace.reset-step");
  expect(steps.map((step) => [step.step, step.outcome])).toEqual([
    ["delete-all", "ok"],
    ["restart-container", "launched"],
  ]);
  expect(steps.every((step) => Number(step.durationMs) >= 0)).toBe(true);
  expect(JSON.stringify(events()), "the client secret authenticates the container").not.toContain(
    "secret",
  );
});

test("a restart that fails is logged at error level before the failure leaves", async () => {
  const events = capturedEvents();

  await expect(
    resetWorkspaceStorage(
      { deleteAll: () => Promise.resolve() },
      { restart: () => Promise.reject(new Error("container would not stop")) },
    ),
  ).rejects.toThrow("container would not stop");

  expect(named(events(), "workspace.reset-step").at(-1)).toMatchObject({
    level: "error",
    step: "restart-container",
    outcome: "threw",
  });
});

test("the owner's reset request is logged with how long the whole reset took", async () => {
  const events = capturedEvents();

  const response = await routeOwnerApiRequest(
    new Request("https://cf-stumble.test/api/workspace/reset", {
      method: "POST",
      headers: { origin: "https://cf-stumble.test" },
    }),
    ownerApiSupervisor(),
    ownerScope,
  );

  expect(response.status).toBe(200);
  const [reset] = named(events(), "workspace.reset");
  expect(reset).toMatchObject({ level: "info", outcome: "reset" });
  expect(reset?.durationMs).toBeGreaterThanOrEqual(0);
});
