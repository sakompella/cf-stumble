/// <reference types="@cloudflare/vitest-plugin/types" />

import { expect, test } from "vitest";
import {
  activeSupervisor,
  artifact,
  expectFailedCandidate,
  labelCandidate,
  prepareWithModuleMap,
} from "../helpers.js";

/**
 * A candidate whose successful headers arrive in time can still fail the startup check while its
 * body is read. Each candidate has its own commit, because the Worker Loader caches by commit.
 *
 * These cases do not reset storage after each test: a check that fails to bound a stalled body is
 * still pending when it fails, and `reset()` waits for it forever. Each case has its own
 * Supervisor name instead. `vitest.config.ts` ignores the platform's own rejections for this file.
 */
const commits = {
  failing: "c123456789abcdef0123456789abcdef01234567",
  stalled: "d123456789abcdef0123456789abcdef01234567",
} as const;

test("records a body that fails after successful headers as failed at the body stage", async () => {
  const control = await activeSupervisor("startup-check-failing-body");
  const label = await labelCandidate(control, commits.failing);

  const result = await prepareWithModuleMap(
    control,
    label,
    artifact(
      commits.failing,
      `
import { DurableObject } from "cloudflare:workers";
export class MainFacet extends DurableObject {
  fetch() {
    let sent = false;
    const body = new ReadableStream({
      pull(controller) {
        if (sent) {
          controller.error(new Error("body exploded"));
        } else {
          sent = true;
          controller.enqueue(new TextEncoder().encode("partial"));
        }
      },
    });
    return new Response(body);
  }
}
`,
    ),
  );

  expect(result).toMatchObject({ ok: true, report: { stage: "body-failed" } });
  await expectFailedCandidate(control, label);
});

test("records a body that never completes as failed at the deadline", async () => {
  const control = await activeSupervisor("startup-check-stalled-body");
  const label = await labelCandidate(control, commits.stalled);

  const result = await prepareWithModuleMap(
    control,
    label,
    artifact(
      commits.stalled,
      `
import { DurableObject } from "cloudflare:workers";
export class MainFacet extends DurableObject {
  fetch() {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("partial"));
      },
    });
    return new Response(body);
  }
}
`,
    ),
    { deadlineMs: 50 },
  );

  expect(result).toMatchObject({
    ok: true,
    report: { stage: "deadline-expired", reason: "response body exceeded the deadline" },
  });
  await expectFailedCandidate(control, label);
});
