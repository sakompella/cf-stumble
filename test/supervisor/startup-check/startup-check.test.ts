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
  FACET_COMPATIBILITY_METHOD,
  generationLabel,
} from "../helpers.js";
import { expectFailedCandidate } from "../generation-reads.js";
import { FACET_COMPATIBILITY } from "../../../src/facet-compatibility.js";

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

async function checked(
  name: string,
  harnessCommit: string,
  source: string,
  options?: Parameters<typeof prepareWithModuleMap>[3],
) {
  const control = await activeSupervisor(name);
  const label = await labelCandidate(control, harnessCommit);

  const result = await prepareWithModuleMap(
    control,
    label,
    artifact(harnessCommit, source),
    options,
  );

  return { control, label, result };
}

test("records a generation as ready when it reports the Supervisor's facet compatibility and answers its startup-check conversation", async () => {
  const { control, label, result } = await checked(
    "startup-check-ordinary",
    commits.ordinary,
    servingFacetSource("ordinary"),
  );

  expect(result).toMatchObject({
    ok: true,
    report: { stage: "ready", generation: { label, status: "ready" } },
  });
  expect(await control.getActiveGeneration()).toMatchObject({ generation: { label: 0 } });
});

test("a generation that loads but fails every message fails its startup check and leaves the active generation serving", async () => {
  const { control, label, result } = await checked(
    "startup-check-failing-messages",
    commits.failingMessages,
    facet(`${FACET_COMPATIBILITY_METHOD}
  async attach() {}
  async createConversation(cwd) { return "conversation:" + cwd; }
  async submit() { throw new Error("every message fails"); }`),
  );

  expect(result).toMatchObject({ ok: true, report: { stage: "conversation-failed" } });
  await expectFailedCandidate(control, label);
});

test("a generation whose attach fails fails its startup check and leaves the active generation serving", async () => {
  const { control, label, result } = await checked(
    "startup-check-failing-attach",
    commits.failingAttach,
    servingFacetSource(
      "failing attach",
      FACET_COMPATIBILITY_METHOD,
      `async attach() { throw new Error("attach fails"); }`,
    ),
  );

  expect(result).toMatchObject({ ok: true, report: { stage: "conversation-failed" } });
  await expectFailedCandidate(control, label);
});

test("a generation in its startup check is attached without generation control", async () => {
  const { result } = await checked(
    "startup-check-no-generation-control",
    commits.noGenerationControl,
    servingFacetSource(
      "no generation control",
      FACET_COMPATIBILITY_METHOD,
      `async attach(host, generations) {
    if (generations !== undefined) throw new Error("a startup check must not pass generation control");
  }`,
    ),
  );

  expect(result).toMatchObject({ ok: true, report: { stage: "ready" } });
});

test.each([
  ["pi-durable@1.4.0/host-1", "9123456789abcdef0123456789abcdef01234567"],
  ["1.4.0", "a123456789abcdef0123456789abcdef01234567"],
])("a generation reporting %s fails its startup check", async (reported, harnessCommit) => {
  const { control, label, result } = await checked(
    `startup-check-compatibility-${harnessCommit}`,
    harnessCommit,
    facet(`compatibility() { return ${JSON.stringify(reported)}; }`),
  );

  expect(result).toMatchObject({
    ok: true,
    report: {
      stage: "compatibility-mismatch",
      reason: `the generation reports ${reported}; this Supervisor requires ${FACET_COMPATIBILITY}`,
    },
  });
  await expectFailedCandidate(control, label);
});

test("records a generation without a compatibility method as failed at mount", async () => {
  const { control, label, result } = await checked(
    "startup-check-no-compatibility",
    commits.noVersion,
    facet(`fetch() { return new Response("ready"); }`),
  );

  expect(result).toMatchObject({ ok: true, report: { stage: "mount-failed" } });

  if (!result.ok) {
    throw new Error("a labeled generation must produce a startup-check report");
  }

  expect(result.report.reason).toContain("compatibility");
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
    facet(`${FACET_COMPATIBILITY_METHOD}
  constructor(ctx, env) {
    super(ctx, env);
    throw new Error("constructor exploded");
  }`),
  );

  expect(result).toMatchObject({ ok: true, report: { stage: "mount-failed" } });
  await expectFailedCandidate(control, label);
});

test("records a candidate whose compatibility call throws as failed at mount", async () => {
  const { control, label, result } = await checked(
    "startup-check-request",
    commits.request,
    facet(`compatibility() { throw new Error("compatibility exploded"); }`),
  );

  expect(result).toMatchObject({ ok: true, report: { stage: "mount-failed" } });
  await expectFailedCandidate(control, label);
});

test("records a candidate that never reports its compatibility as failed at the deadline", async () => {
  const { control, label, result } = await checked(
    "startup-check-delayed",
    commits.delayed,
    facet(`compatibility() { return new Promise(() => {}); }`),
    { deadlines: { compatibilityMs: 50 } },
  );

  expect(result).toMatchObject({ ok: true, report: { stage: "deadline-expired" } });
  await expectFailedCandidate(control, label);
});

test("records a candidate whose startup-check conversation never settles as failed at the deadline", async () => {
  const running = JSON.stringify([
    ["r", { conversation: { id: 1 }, entries: [], docs: { "pi.live": { run: { inputs: [1] } } } }],
  ]);

  const { control, label, result } = await checked(
    "startup-check-unsettled",
    commits.unsettled,
    facet(`${FACET_COMPATIBILITY_METHOD}
  async attach() {}
  async createConversation(cwd) { return "conversation:" + cwd; }
  async submit() { return 1; }
  async events() { return new Response(${JSON.stringify(`${running}\n`)}).body; }`),
    { deadlines: { conversationMs: 500 } },
  );

  expect(result).toMatchObject({ ok: true, report: { stage: "deadline-expired" } });
  await expectFailedCandidate(control, label);
});

test("remounts a checked generation instead of reusing its warm candidate instance", async () => {
  const control = await activeSupervisor("startup-check-fresh-instance");
  const label = await labelCandidate(control, commits.fresh);

  const candidate = artifact(
    commits.fresh,
    servingFacetSource(
      "fresh",
      `constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.kv.put("constructions", (ctx.storage.kv.get("constructions") ?? 0) + 1);
  }
  compatibility() {
    const calls = (this.ctx.storage.kv.get("calls") ?? 0) + 1;
    this.ctx.storage.kv.put("calls", calls);
    const fresh = this.ctx.storage.kv.get("constructions") === calls;
    return fresh ? ${JSON.stringify(FACET_COMPATIBILITY)} : "a reused instance";
  }`,
    ),
  );

  await storeModuleMap(control, candidate);
  const first = await control.prepareGeneration(generationLabel(label));
  const second = await control.prepareGeneration(generationLabel(label));

  expect(first).toMatchObject({ ok: true, report: { stage: "ready" } });
  expect(second).toMatchObject({
    ok: true,
    report: { stage: "ready", generation: { label, status: "ready" }, effect: "no-op" },
  });
});

test("overlapping preparations of one generation do not abort each other's startup check", async () => {
  const control = await activeSupervisor("startup-check-overlap");
  const label = await labelCandidate(control, commits.ordinary);

  await storeModuleMap(
    control,
    artifact(
      commits.ordinary,
      servingFacetSource(
        "overlapping",
        `async compatibility() {
    await new Promise((resolve) => setTimeout(resolve, 50));
    return ${JSON.stringify(FACET_COMPATIBILITY)};
  }`,
      ),
    ),
  );

  const reports = await Promise.all([
    control.prepareGeneration(generationLabel(label)),
    control.prepareGeneration(generationLabel(label)),
  ]);

  expect(reports).toMatchObject([
    { ok: true, report: { stage: "ready" } },
    { ok: true, report: { stage: "ready" } },
  ]);
});
