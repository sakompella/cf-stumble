import { expect, test } from "vitest";
import { buildGeneration } from "../../src/generation/build.js";
import { materializeGeneration } from "../../src/agent/runtime/index.js";
import { MemoryStore } from "../../src/storage/memory.js";
import type { Module } from "../../src/generation/types.js";
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
  expect(result.checks).toEqual([
    {
      capability: "materialization",
      status: "FAIL",
      detail: expect.stringContaining("prompt.md"),
    },
  ]);
});
