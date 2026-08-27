import { expect, test } from "vitest";
import { expectOk } from "../support/result.js";
import {
  DEFAULT_MODEL_REQUEST_ID,
  RecordedModelResponseSource,
  type AgentDefinition,
  type ModelResponseSource,
} from "../../src/agent/runtime/index.js";
import { buildGeneration as buildGenerationResult } from "../../src/generation/build.js";
import { MemoryGenerationRegistry } from "../../src/generation/registry.js";
import { PointerManager } from "../../src/pointer/index.js";
import { MemoryStore } from "../../src/storage/memory.js";
import type { Workspace } from "../../src/tools/index.js";
import { defaultResponseSource, defaultWorkspace } from "../../src/validation/preflight-probes.js";
import { type PreflightProbe, runPreflight, ValidationGate } from "../../src/validation/index.js";

const author = {
  name: "Preflight Test",
  email: "preflight@example.com",
  timestamp: 1_700_000_000,
  timezoneOffsetMinutes: 0,
} satisfies Parameters<typeof buildGenerationResult>[1]["author"];

const encoder = new TextEncoder();

async function buildGeneration(...args: Parameters<typeof buildGenerationResult>) {
  return (await buildGenerationResult(...args)).unwrap("preflight fixture must build");
}

function module(path: string, content: string) {
  return { path, content: encoder.encode(content), executable: false };
}

test("a candidate missing a required module fails preflight with the module named", async () => {
  const store = new MemoryStore();
  const candidate = await buildGeneration(store, {
    modules: [module("policy.md", "allow-all\n")],
    parent: undefined,
    author,
    createdAt: author.timestamp,
    summary: "missing prompt",
  });

  const result = await runPreflight({ store, candidate: candidate.sha });

  expect(result.status).toBe("FAIL");
  expect(result.failure).toContain("prompt.md");
  const check = result.checks[0];
  expect(check?.capability).toBe("materialization");
  expect(check?.status).toBe("FAIL");
  expect(check && "detail" in check ? check.detail : "").toContain("prompt.md");
});

test("a healthy candidate passes all four capability checks", async () => {
  const store = new MemoryStore();
  const candidate = await buildGeneration(store, {
    modules: [module("prompt.md", "healthy prompt\n"), module("policy.md", "allow-all\n")],
    parent: undefined,
    author,
    createdAt: author.timestamp,
    summary: "healthy candidate",
  });

  const result = await runPreflight({ store, candidate: candidate.sha });

  expect(result.status).toBe("PASS");
  expect(result.failure).toBeUndefined();
  expect(result.checks.map((check) => check.capability)).toEqual([
    "materialization",
    "read",
    "write",
    "edit",
    "bash",
    "self-edit",
  ]);
  expect(result.checks.every((check) => check.status === "PASS")).toBe(true);
});

test("partial success does not pass when the edit capability is lost", async () => {
  const store = new MemoryStore();
  const candidate = await buildHealthyCandidate(store);

  const result = await runPreflight({
    store,
    candidate: candidate.sha,
    responseSourceFactory: brokenEditSource,
  });

  expect(result.status).toBe("FAIL");
  expect(result.failure).toContain("edit");
  expect(result.failure).toContain("expected exactly one match, found none");
  expect(result.checks.find((check) => check.capability === "read")?.status).toBe("PASS");
  expect(
    result.checks
      .filter((check) => check.capability !== "edit")
      .every((check) => check.status === "PASS"),
  ).toBe(true);
  expect(result.checks.find((check) => check.capability === "edit")?.status).toBe("FAIL");
});

test("a candidate that cannot edit a copy of its own definition fails preflight", async () => {
  const store = new MemoryStore();
  const candidate = await buildHealthyCandidate(store);

  const result = await runPreflight({
    store,
    candidate: candidate.sha,
    workspaceFactory: brokenSelfEditWorkspace,
  });

  expect(result.status).toBe("FAIL");
  expect(result.failure).toContain("self-edit");
  expect(result.checks.find((check) => check.capability === "self-edit")?.status).toBe("FAIL");
});

test("a harness error is INCONCLUSIVE rather than FAIL and remains distinguishable", async () => {
  const store = new MemoryStore();
  const candidate = await buildHealthyCandidate(store);

  const result = await runPreflight({
    store,
    candidate: candidate.sha,
    workspaceFactory: (probe, definition) => {
      if (probe.capability === "bash") {
        throw new Error("workspace blew up");
      }
      return defaultWorkspace(probe, definition);
    },
  });

  expect(result.status).toBe("INCONCLUSIVE");
  expect(result.failure).toContain("workspace blew up");
  expect(result.checks.find((check) => check.capability === "bash")?.status).toBe("INCONCLUSIVE");
  expect(result.checks.some((check) => check.status === "FAIL")).toBe(false);
});

test("a preflight failure blocks promotion through the real validation gate", async () => {
  const store = new MemoryStore();
  const live = await buildHealthyCandidate(store);
  const candidate = await buildHealthyCandidate(store);
  const registry = new MemoryGenerationRegistry();
  const allocated = await registerLoaded(registry, candidate);
  expect(expectOk(await store.setPointer(live.sha, undefined))).toBe(true);

  const gate = new ValidationGate({
    pointerStore: store,
    resultStore: emptyResultStore(),
    corpus: [],
    execute: () => Promise.reject(new Error("corpus must not run after preflight failure")),
    preflight: (candidateSha) =>
      runPreflight({
        store,
        candidate: candidateSha,
        responseSourceFactory: brokenEditSource,
      }),
    generationRegistry: registry,
  });
  const run = expectOk(
    await gate.validate(candidate.sha, {
      generation: allocated.number,
      artifactDigest: candidate.sha,
      validatedAgainstGeneration: undefined,
    }),
  );

  expect(run.result).toMatchObject({
    verdict: "fail",
    preflight: { status: "FAIL" },
    caseResults: [],
  });
  expect(run.attestation).toBeUndefined();

  const pointer = new PointerManager({
    store,
    corpusVersion: run.result.corpusVersion,
    gateVersion: run.result.gateVersion,
  });
  expect(expectOk(await pointer.promote(candidate.sha, attestationFor(run.result)))).toMatchObject({
    outcome: "rejected",
    reason: { kind: "not-passing" },
  });
  expect(expectOk(await store.readPointer())).toBe(live.sha);
  expect((await registry.get(allocated.number))?.state).toBe("validation_failed");
});
type Attestation = Parameters<PointerManager["promote"]>[1];

function attestationFor(
  result: Pick<
    Attestation,
    | "candidate"
    | "generation"
    | "artifactDigest"
    | "validatedAgainst"
    | "validatedAgainstGeneration"
    | "corpusVersion"
    | "gateVersion"
    | "verdict"
    | "createdAt"
  >,
): Attestation {
  return {
    candidate: result.candidate,
    generation: result.generation,
    artifactDigest: result.artifactDigest,
    validatedAgainst: result.validatedAgainst,
    validatedAgainstGeneration: result.validatedAgainstGeneration,
    corpusVersion: result.corpusVersion,
    gateVersion: result.gateVersion,
    verdict: result.verdict,
    createdAt: result.createdAt,
  };
}

const absentResult = void 0;

async function registerLoaded(
  registry: MemoryGenerationRegistry,
  candidate: Awaited<ReturnType<typeof buildHealthyCandidate>>,
) {
  const allocated = await registry.allocate({
    commit: candidate.sha,
    baseline: undefined,
    idempotencyKey: "preflight-promotion",
    createdAt: candidate.createdAt,
  });
  await registry.transition(allocated.number, {
    state: "loaded",
    artifactDigest: candidate.sha,
  });
  return allocated;
}

function emptyResultStore() {
  return {
    put: () => Promise.resolve(),
    get: () => Promise.resolve(absentResult),
    query: () => Promise.resolve([]),
  };
}

function buildHealthyCandidate(store: MemoryStore) {
  return buildGeneration(store, {
    modules: [module("prompt.md", "healthy prompt\n"), module("policy.md", "allow-all\n")],
    parent: undefined,
    author,
    createdAt: author.timestamp,
    summary: "healthy candidate",
  });
}

function brokenEditSource(probe: PreflightProbe, definition: AgentDefinition): ModelResponseSource {
  if (probe.capability !== "edit") {
    return defaultResponseSource(probe, definition);
  }
  return new RecordedModelResponseSource([
    {
      requestId: DEFAULT_MODEL_REQUEST_ID,
      content: JSON.stringify({
        type: "tool_call",
        name: "edit",
        arguments: {
          path: probe.path,
          oldText: "missing text",
          newText: probe.newText,
        },
      }),
    },
    {
      requestId: DEFAULT_MODEL_REQUEST_ID,
      content: JSON.stringify({ type: "final", content: "preflight complete" }),
    },
  ]);
}

function brokenSelfEditWorkspace(probe: PreflightProbe, definition: AgentDefinition): Workspace {
  if (probe.capability !== "self-edit") {
    return defaultWorkspace(probe, definition);
  }
  return {
    readFile: () => Promise.resolve("not the candidate definition\n"),
    writeFile: () => Promise.resolve(),
    listFiles: () => Promise.resolve([]),
    exists: () => Promise.resolve(false),
    execute: () => Promise.resolve({ status: "completed", exitCode: 0, stdout: "", stderr: "" }),
  };
}
