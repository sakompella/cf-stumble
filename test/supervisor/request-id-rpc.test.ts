/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, test, vi } from "vitest";
import { newRequestId, type LogFields } from "../../src/diagnostics.js";
import { capturedEvents, everythingLogged } from "../log-capture.js";

/**
 * The Supervisor parses the request id its RPC methods receive, so anything that is not a UUID is
 * dropped from the events and the call answers as it would with a real id. No test here has a
 * container, so the workspace answers "unavailable" and the events are error events.
 * `WorkspaceHost.credential` parses its id the same way, but the test runtime cannot construct a
 * Workspace Host (its container API needs a container-enabled object), so `parseRequestId` is
 * tested directly in `test/workspace/credential-status-log.test.ts`.
 */

const FORGED = "x\nevent=forged";

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

function idsOnEvents(events: readonly LogFields[]): (string | number | boolean | null)[] {
  return events.flatMap((entry) => (entry.requestId === undefined ? [] : [entry.requestId]));
}

test.each(["listProjects", "getGitHubConnection"] as const)(
  "Supervisor.%s drops a malformed request id and keeps a real one",
  async (method) => {
    const events = capturedEvents();
    const real = newRequestId();

    const [withBad, withReal] = await runInDurableObject(
      env.SUPERVISOR.getByName(`rpc-${method}`),
      async (supervisor) => [await supervisor[method](FORGED), await supervisor[method](real)],
    );

    expect(idsOnEvents(events())).not.toContain(FORGED);
    expect(idsOnEvents(events())).toContain(real);
    expect(withBad).toEqual(withReal);
    expect(everythingLogged()).not.toContain("event=forged");
  },
);
