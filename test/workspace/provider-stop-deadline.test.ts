import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, expect, test, vi } from "vitest";
import { ProviderContainerAPI } from "../../src/workspace/provider-container.js";
import { ProviderLink } from "../../src/workspace/provider-link.js";
import { providerEvent } from "../../src/workspace/provider-state.js";

afterEach(() => {
  vi.useRealTimers();
});

test("a stop the provider never answers fails after its deadline and drops the provider", async () => {
  await runInDurableObject(env.SUPERVISOR.getByName("provider-stop"), async (_instance, state) => {
    vi.useFakeTimers();
    const link = new ProviderLink(state);
    const provider = link.accept().webSocket;
    provider?.accept();
    link.update(providerEvent.started({ runtime: "orb-runtime" }));
    const container = new ProviderContainerAPI(link, "workspace");

    const failed = expect(container.stop()).rejects.toThrow("the workspace provider disconnected");
    await vi.advanceTimersByTimeAsync(30_000);

    await failed;
    expect(container.running()).toBe(false);
  });
});
