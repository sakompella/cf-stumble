/// <reference types="@cloudflare/vitest-plugin/types" />

import { reset } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import { STARTUP_CHECK_MAX_BODY_BYTES } from "../../../src/supervisor/startup-check/index.js";
import {
  activeSupervisor,
  artifact,
  commits,
  expectFailedCandidate,
  labelCandidate,
} from "../helpers.js";

afterEach(async () => {
  await reset();
});

test("records a generation as ready when its candidate completes an ordinary request", async () => {
  const control = await activeSupervisor("startup-check-ordinary");
  const label = await labelCandidate(control, commits.ordinary);

  const result = await control.checkGenerationStartup(
    label,
    artifact(
      commits.ordinary,
      `
import { DurableObject } from "cloudflare:workers";
export class MainFacet extends DurableObject {
  fetch() { return new Response("ordinary response"); }
}
`,
    ),
  );

  expect(result).toMatchObject({
    ok: true,
    report: { stage: "ready", status: 200, generation: { label, status: "ready" } },
  });
  expect(await control.getActiveGeneration()).toMatchObject({ generation: { label: 0 } });
});

test("records a 400 response as failed at the response stage", async () => {
  const control = await activeSupervisor("startup-check-client-error-response");
  const label = await labelCandidate(control, commits.notFound);

  const result = await control.checkGenerationStartup(
    label,
    artifact(
      commits.notFound,
      `
import { DurableObject } from "cloudflare:workers";
export class MainFacet extends DurableObject {
  fetch() { return new Response("invalid startup request", { status: 400 }); }
}
`,
    ),
  );

  expect(result).toMatchObject({ ok: true, report: { stage: "response-rejected", status: 400 } });
  await expectFailedCandidate(control, label);
});

test("records a parse-invalid candidate as failed before headers", async () => {
  const control = await activeSupervisor("startup-check-parse");
  const label = await labelCandidate(control, commits.parse);

  const result = await control.checkGenerationStartup(
    label,
    artifact(commits.parse, "export class MainFacet extends {"),
  );

  expect(result).toMatchObject({ ok: true, report: { stage: "headers-not-received" } });
  if (!result.ok) {
    throw new Error("a labeled generation must produce a startup-check report");
  }

  expect(result.report.reason, "the runtime's own diagnosis is the only detail we keep").toContain(
    "Worker",
  );
  await expectFailedCandidate(control, label);
});

test("records a candidate without MainFacet as failed before headers", async () => {
  const control = await activeSupervisor("startup-check-missing-facet");
  const label = await labelCandidate(control, commits.missingFacet);

  const result = await control.checkGenerationStartup(
    label,
    artifact(
      commits.missingFacet,
      `export default { fetch() { return new Response("no durable object"); } };`,
    ),
  );

  expect(result).toMatchObject({ ok: true, report: { stage: "headers-not-received" } });
  await expectFailedCandidate(control, label);
});

test("records a constructor-throwing candidate as failed before headers", async () => {
  const control = await activeSupervisor("startup-check-constructor");
  const label = await labelCandidate(control, commits.constructor);

  const result = await control.checkGenerationStartup(
    label,
    artifact(
      commits.constructor,
      `
import { DurableObject } from "cloudflare:workers";
export class MainFacet extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    throw new Error("constructor exploded");
  }
  fetch() { return new Response("unreachable"); }
}
`,
    ),
  );

  expect(result).toMatchObject({ ok: true, report: { stage: "headers-not-received" } });
  await expectFailedCandidate(control, label);
});

test("records a first-request throw as failed before headers", async () => {
  const control = await activeSupervisor("startup-check-request");
  const label = await labelCandidate(control, commits.request);

  const result = await control.checkGenerationStartup(
    label,
    artifact(
      commits.request,
      `
import { DurableObject } from "cloudflare:workers";
export class MainFacet extends DurableObject {
  fetch() { throw new Error("first request exploded"); }
}
`,
    ),
  );

  expect(result).toMatchObject({ ok: true, report: { stage: "headers-not-received" } });
  await expectFailedCandidate(control, label);
});

test("records a 500 response as failed at the response stage", async () => {
  const control = await activeSupervisor("startup-check-error-response");
  const label = await labelCandidate(control, commits.errorResponse);

  const result = await control.checkGenerationStartup(
    label,
    artifact(
      commits.errorResponse,
      `
import { DurableObject } from "cloudflare:workers";
export class MainFacet extends DurableObject {
  fetch() { return new Response("failure", { status: 500 }); }
}
`,
    ),
  );

  expect(result).toMatchObject({ ok: true, report: { stage: "response-rejected", status: 500 } });
  await expectFailedCandidate(control, label);
});

test("records a candidate that never sends headers as failed at the deadline", async () => {
  const control = await activeSupervisor("startup-check-delayed");
  const label = await labelCandidate(control, commits.delayed);

  const result = await control.checkGenerationStartup(
    label,
    artifact(
      commits.delayed,
      `
import { DurableObject } from "cloudflare:workers";
export class MainFacet extends DurableObject {
  fetch() { return new Promise(() => {}); }
}
`,
    ),
    { deadlineMs: 50 },
  );

  expect(result).toMatchObject({
    ok: true,
    report: { stage: "deadline-expired", reason: "response headers exceeded the deadline" },
  });
  await expectFailedCandidate(control, label);
});

test("records a body above the byte bound as failed at the body stage", async () => {
  const control = await activeSupervisor("startup-check-oversized");
  const label = await labelCandidate(control, commits.oversized);

  const result = await control.checkGenerationStartup(
    label,
    artifact(
      commits.oversized,
      `
import { DurableObject } from "cloudflare:workers";
export class MainFacet extends DurableObject {
  fetch() { return new Response("x".repeat(${STARTUP_CHECK_MAX_BODY_BYTES + 1})); }
}
`,
    ),
  );

  expect(result).toMatchObject({ ok: true, report: { stage: "body-failed" } });
  await expectFailedCandidate(control, label);
});

test("rejects a different harness commit without changing the labeled generation", async () => {
  const control = await activeSupervisor("startup-check-mismatch");
  const label = await labelCandidate(control, commits.mismatch);

  const result = await control.checkGenerationStartup(
    label,
    artifact(
      commits.ordinary,
      `
import { DurableObject } from "cloudflare:workers";
export class MainFacet extends DurableObject {
  fetch() { return new Response("wrong generation"); }
}
`,
    ),
  );

  expect(result).toEqual({
    ok: false,
    problem: {
      code: "artifact-harness-commit-mismatch",
      label,
      generationHarnessCommit: commits.mismatch,
      artifactHarnessCommit: commits.ordinary,
    },
  });
  expect(await control.getGeneration(label)).toMatchObject({ status: "candidate" });
  expect(await control.getActiveGeneration()).toMatchObject({ generation: { label: 0 } });
});

test("rejects an invalid artifact without changing the labeled generation", async () => {
  const control = await activeSupervisor("startup-check-malformed-artifact");
  const label = await labelCandidate(control, commits.malformed);

  const result = await control.checkGenerationStartup(label, {
    harnessCommit: commits.malformed,
    entryModule: "missing.js",
    modules: [],
  });

  expect(result).toEqual({ ok: false, problem: { code: "empty-module-map" } });
  expect(await control.getGeneration(label)).toMatchObject({ status: "candidate" });
  expect(await control.getActiveGeneration()).toMatchObject({ generation: { label: 0 } });
});

test("remounts a checked generation instead of reusing its warm candidate instance", async () => {
  const control = await activeSupervisor("startup-check-fresh-instance");
  const label = await labelCandidate(control, commits.fresh);
  const candidate = artifact(
    commits.fresh,
    `
import { DurableObject } from "cloudflare:workers";
export class MainFacet extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS constructions (count INTEGER NOT NULL)");
    ctx.storage.sql.exec("INSERT INTO constructions (count) VALUES (1)");
  }
  fetch() {
    const count = this.ctx.storage.sql.exec("SELECT COUNT(*) AS count FROM constructions").one().count;
    return new Response("construction " + count, { status: count === 1 ? 200 : 201 });
  }
}
`,
  );

  const first = await control.checkGenerationStartup(label, candidate);
  const second = await control.checkGenerationStartup(label, candidate);

  expect(first).toMatchObject({ ok: true, report: { stage: "ready", status: 200 } });
  expect(second).toMatchObject({
    ok: true,
    report: {
      stage: "ready",
      status: 201,
      generation: { label, status: "ready" },
      effect: "no-op",
    },
  });
});
