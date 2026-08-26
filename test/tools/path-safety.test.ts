import { expect, test } from "vitest";
import {
  executePrimitive,
  InMemoryWorkspace,
  PRIMITIVE_KINDS,
  type PrimitiveCall,
} from "../../src/tools/index.js";

const invalidPaths = [
  { path: "../../etc/passwd", reason: "path-traversal" },
  { path: "/etc/passwd", reason: "absolute" },
  { path: "safe\0file", reason: "nul-byte" },
] as const;

const filesystemCalls = (path: string): readonly PrimitiveCall[] => [
  { kind: "read", path },
  { kind: "write", path, content: "content" },
  { kind: "edit", path, oldText: "old", newText: "new" },
];

test.each(invalidPaths)("rejects $reason paths for every filesystem primitive", async (invalid) => {
  for (const call of filesystemCalls(invalid.path)) {
    const result = await executePrimitive(call, new InMemoryWorkspace());

    expect(result).toEqual({
      ok: false,
      kind: call.kind,
      error: { kind: "invalid-path", path: invalid.path, reason: invalid.reason },
    });
  }
});

test("the primitive registry contains exactly the four fixed actions", () => {
  expect(PRIMITIVE_KINDS).toEqual(["read", "write", "edit", "bash"]);
});
