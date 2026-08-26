import { expect, test } from "vitest";
import { buildGeneration } from "../../src/generation/build.js";
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
