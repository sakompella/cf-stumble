import { expect, test } from "vitest";
import {
  DEFAULT_MODEL_REQUEST_ID,
  RecordedModelResponseSource,
  type AgentDefinition,
  type ModelResponseSource,
} from "../../src/agent/runtime/index.js";
import { buildGeneration } from "../../src/generation/build.js";
import type { Module } from "../../src/generation/types.js";
import { MemoryStore } from "../../src/storage/memory.js";
import { InMemoryWorkspace } from "../../src/tools/index.js";
import {
  defaultResponseSource,
  defaultWorkspace,
} from "../../src/validation/preflight-probes.js";
import type { PreflightProbe } from "../../src/validation/preflight.js";
import { runPreflight } from "../../src/validation/preflight.js";

const author = {
  name: "Preflight Test",
  email: "preflight@example.com",
  timestamp: 1_700_000_000,
  timezoneOffsetMinutes: 0,
} satisfies Parameters<typeof buildGeneration>[1]["author"];

const encoder = new TextEncoder();

function module(path: string, content: string): Module {
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

test("a candidate whose edit primitive no longer matches fails preflight and names edit", async () => {
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
  expect(result.checks.find((check) => check.capability === "bash")?.status).toBe(
    "INCONCLUSIVE",
  );
  expect(result.checks.some((check) => check.status === "FAIL")).toBe(false);
});

function buildHealthyCandidate(store: MemoryStore) {
  return buildGeneration(store, {
    modules: [module("prompt.md", "healthy prompt\n"), module("policy.md", "allow-all\n")],
    parent: undefined,
    author,
    createdAt: author.timestamp,
    summary: "healthy candidate",
  });
}

function brokenEditSource(
  probe: PreflightProbe,
  definition: AgentDefinition,
): ModelResponseSource {
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

function brokenSelfEditWorkspace(
  probe: PreflightProbe,
  definition: AgentDefinition,
) {
  if (probe.capability !== "self-edit") {
    return defaultWorkspace(probe, definition);
  }
  return new InMemoryWorkspace({
    files: [{ path: probe.path, content: "not the candidate definition\n" }],
  });
}
