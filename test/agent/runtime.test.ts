import { expect, test } from "vitest";
import { buildGeneration } from "../../src/generation/build.js";
import type { Module } from "../../src/generation/types.js";
import {
  AgentMaterializationError,
  materializeGeneration,
} from "../../src/agent/runtime/index.js";
import { MemoryStore } from "../../src/storage/memory.js";

const author = {
  name: "Runtime Test",
  email: "runtime@example.com",
  timestamp: 1_700_000_000,
  timezoneOffsetMinutes: 0,
} as const;

const encoder = new TextEncoder();

function modules(extra: readonly Module[] = []): readonly Module[] {
  return [
    { path: "prompt.md", content: encoder.encode("system prompt\n"), executable: false },
    { path: "policy.md", content: encoder.encode("allow-all\n"), executable: false },
    ...extra,
  ];
}

async function generation(sourceModules: readonly Module[]) {
  const store = new MemoryStore();
  const built = await buildGeneration(store, {
    modules: sourceModules,
    parent: undefined,
    author,
    createdAt: author.timestamp,
    summary: "runtime test",
  });
  return { store, built };
}

test("materializes prompt, policy, and skills from generation bytes", async () => {
  const { store, built } = await generation(
    modules([
      {
        path: "skills/review.md",
        content: encoder.encode("review instructions\n"),
        executable: false,
      },
    ]),
  );

  await expect(materializeGeneration(store, built.sha)).resolves.toEqual({
    generation: built,
    systemPrompt: "system prompt\n",
    policy: "allow-all\n",
    skills: [{ name: "review", content: "review instructions\n" }],
  });
});

test("fails with the missing required module named", async () => {
  const { store, built } = await generation([
    { path: "prompt.md", content: encoder.encode("system prompt\n"), executable: false },
  ]);

  await expect(materializeGeneration(store, built.sha)).rejects.toEqual(
    new AgentMaterializationError("missing-module", "policy.md", 'required module "policy.md" is missing'),
  );
});
