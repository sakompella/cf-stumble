import { reset } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import {
  activeSupervisor,
  artifact,
  commits,
  labelCandidate,
  prepareWithModuleMap,
  servingFacetSource,
  storeModuleMap,
  PI_DURABLE_VERSION_METHOD,
} from "../helpers.js";
import { expectFailedCandidate } from "../generation-reads.js";
import { PI_DURABLE_VERSION } from "../../../src/pi-durable-version.js";

afterEach(async () => {
  await reset();
});

function facet(members: string): string {
  return `
import { DurableObject } from "cloudflare:workers";
export class MainFacet extends DurableObject {
  ${members}
}
`;
}

async function checked(name: string, harnessCommit: string, source: string, deadlineMs?: number) {
  const control = await activeSupervisor(name);
  const label = await labelCandidate(control, harnessCommit);

  const result = await prepareWithModuleMap(
    control,
    label,
    artifact(harnessCommit, source),
    deadlineMs === undefined ? undefined : { deadlineMs },
  );

  return { control, label, result };
}

test("records a generation as ready when it reports the Supervisor's Pi Durable version", async () => {
  const { control, label, result } = await checked(
    "startup-check-ordinary",
    commits.ordinary,
    servingFacetSource("ordinary"),
  );

  expect(result).toMatchObject({
    ok: true,
    report: {
      stage: "ready",
      reason: `the generation runs Pi Durable ${PI_DURABLE_VERSION}`,
      generation: { label, status: "ready" },
    },
  });
  expect(await control.getActiveGeneration()).toMatchObject({ generation: { label: 0 } });
});

const PI_DURABLE_MISMATCH_COMMIT = "9123456789abcdef0123456789abcdef01234567";

test("a generation built with another Pi Durable version fails its startup check", async () => {
  const { control, label, result } = await checked(
    "startup-check-pi-durable-version",
    PI_DURABLE_MISMATCH_COMMIT,
    facet(`piDurableVersion() { return "0.0.1"; }`),
  );

  expect(result).toMatchObject({ ok: true, report: { stage: "version-mismatch" } });
  await expectFailedCandidate(control, label);
});

test("records a generation from before Pi Durable as failed at mount", async () => {
  const { control, label, result } = await checked(
    "startup-check-no-version",
    commits.noVersion,
    facet(`fetch() { return new Response("ready"); }`),
  );

  expect(result).toMatchObject({ ok: true, report: { stage: "mount-failed" } });
  await expectFailedCandidate(control, label);
});

test("records a parse-invalid candidate as failed at mount", async () => {
  const { control, label, result } = await checked(
    "startup-check-parse",
    commits.parse,
    "export class MainFacet extends {",
  );

  expect(result).toMatchObject({ ok: true, report: { stage: "mount-failed" } });

  if (!result.ok) {
    throw new Error("a labeled generation must produce a startup-check report");
  }

  expect(result.report.reason, "the runtime's own diagnosis is the only detail we keep").toContain(
    "Worker",
  );
  await expectFailedCandidate(control, label);
});

test("records a candidate without MainFacet as failed at mount", async () => {
  const { control, label, result } = await checked(
    "startup-check-missing-facet",
    commits.missingFacet,
    `export default { fetch() { return new Response("no durable object"); } };`,
  );

  expect(result).toMatchObject({ ok: true, report: { stage: "mount-failed" } });
  await expectFailedCandidate(control, label);
});

test("records a constructor-throwing candidate as failed at mount", async () => {
  const { control, label, result } = await checked(
    "startup-check-constructor",
    commits.constructor,
    facet(`${PI_DURABLE_VERSION_METHOD}
  constructor(ctx, env) {
    super(ctx, env);
    throw new Error("constructor exploded");
  }`),
  );

  expect(result).toMatchObject({ ok: true, report: { stage: "mount-failed" } });
  await expectFailedCandidate(control, label);
});

test("records a candidate whose version call throws as failed at mount", async () => {
  const { control, label, result } = await checked(
    "startup-check-request",
    commits.request,
    facet(`piDurableVersion() { throw new Error("version exploded"); }`),
  );

  expect(result).toMatchObject({ ok: true, report: { stage: "mount-failed" } });
  await expectFailedCandidate(control, label);
});

test("records a candidate that never reports its version as failed at the deadline", async () => {
  const { control, label, result } = await checked(
    "startup-check-delayed",
    commits.delayed,
    facet(`piDurableVersion() { return new Promise(() => {}); }`),
    50,
  );

  expect(result).toMatchObject({
    ok: true,
    report: { stage: "deadline-expired", reason: "the Pi Durable version exceeded the deadline" },
  });
  await expectFailedCandidate(control, label);
});

test("remounts a checked generation instead of reusing its warm candidate instance", async () => {
  const control = await activeSupervisor("startup-check-fresh-instance");
  const label = await labelCandidate(control, commits.fresh);

  const candidate = artifact(
    commits.fresh,
    facet(`constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.kv.put("constructions", (ctx.storage.kv.get("constructions") ?? 0) + 1);
  }
  piDurableVersion() {
    const calls = (this.ctx.storage.kv.get("calls") ?? 0) + 1;
    this.ctx.storage.kv.put("calls", calls);
    const fresh = this.ctx.storage.kv.get("constructions") === calls;
    return fresh ? ${JSON.stringify(PI_DURABLE_VERSION)} : "a reused instance";
  }`),
  );

  await storeModuleMap(control, candidate);
  const first = await control.prepareGeneration(label);
  const second = await control.prepareGeneration(label);

  expect(first).toMatchObject({ ok: true, report: { stage: "ready" } });
  expect(second).toMatchObject({
    ok: true,
    report: { stage: "ready", generation: { label, status: "ready" }, effect: "no-op" },
  });
});
