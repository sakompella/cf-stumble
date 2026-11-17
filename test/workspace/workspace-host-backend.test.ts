import { afterEach, expect, test, vi } from "vitest";
import { withHost } from "./idle-host.js";
import { restoreWorkspaceMembers } from "./host-fixtures.js";

afterEach(() => {
  vi.restoreAllMocks();
  restoreWorkspaceMembers();
});

test("choosing Provider while a container runs stops it and says the next one starts on Cloudflare because no provider is connected", async () => {
  const result = await withHost("host-backend-stopped", async (host, _state, container) => ({
    change: await host.setBackend("provider"),
    destroyed: container.destroyed,
  }));

  expect(result.change).toEqual({
    ok: true,
    backend: "provider",
    container: "stopped",
    startsOn: "cloudflare",
  });
  expect(result.destroyed).toEqual(["backend"]);
});

test("choosing a backend while no container runs says none was running and destroys nothing", async () => {
  const result = await withHost("host-backend-not-running", async (host, _state, container) => {
    container.running = false;

    return { change: await host.setBackend("provider"), destroyed: container.destroyed };
  });

  expect(result.change).toEqual({
    ok: true,
    backend: "provider",
    container: "not-running",
    startsOn: "cloudflare",
  });
  expect(result.destroyed).toEqual([]);
});

test("choosing the backend that is already chosen touches nothing, even with a container running", async () => {
  const result = await withHost("host-backend-kept", async (host, _state, container) => ({
    change: await host.setBackend("cloudflare"),
    destroyed: container.destroyed,
  }));

  expect(result.change).toEqual({
    ok: true,
    backend: "cloudflare",
    container: "kept",
    startsOn: "cloudflare",
  });
  expect(result.destroyed).toEqual([]);
});
