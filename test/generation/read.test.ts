import { describe, expect, it } from "vitest";

import { buildGeneration } from "../../src/generation/build.js";
import { readGeneration } from "../../src/generation/read.js";
import { MemoryStore } from "../../src/storage/memory.js";
import type { Module } from "../../src/generation/types.js";

const author = {
  name: "Build Bot",
  email: "build@example.com",
  timestamp: 1_700_000_000,
  timezoneOffsetMinutes: 0,
} as const;

const modules = [
  {
    path: "skills/rust/style.md",
    content: new Uint8Array([0, 255, 10]),
    executable: false,
  },
  {
    path: "bin/run",
    content: new TextEncoder().encode("#!/bin/sh\necho ok\n"),
    executable: true,
  },
] satisfies readonly Module[];

describe("readGeneration", () => {
  it("round-trips module paths, bytes, and executable bits", async () => {
    const store = new MemoryStore();
    const built = await buildGeneration(store, {
      modules,
      parent: undefined,
      author,
      createdAt: author.timestamp,
      summary: "nested modules",
    });

    const loaded = await readGeneration(store, built.sha);

    expect(loaded.generation).toEqual(built);
    expect(loaded.generation).not.toHaveProperty("number");
    expect(loaded.modules).toHaveLength(modules.length);
    expect(loaded.modules).toEqual(expect.arrayContaining(modules));
  });
});
