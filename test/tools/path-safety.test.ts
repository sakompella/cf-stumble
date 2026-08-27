import { expect, test } from "vitest";
import {
  executePrimitive,
  InMemoryWorkspace,
  parseWorkspacePath,
  PRIMITIVE_KINDS,
  type PrimitiveCall,
  type WorkspacePathRejection,
} from "../../src/tools/index.js";
import { expectErr } from "../support/result.js";

const invalidPaths = [
  { path: "../../etc/passwd", rejection: "path-traversal" },
  { path: "/etc/passwd", rejection: "absolute" },
  { path: "safe\0file", rejection: "nul-byte" },
] as const satisfies readonly { path: string; rejection: WorkspacePathRejection }[];

/** Every reason the parser can give, so a new one cannot be added without a case here. */
const everyRejection = [
  { path: "", rejection: "empty" },
  { path: "/etc/passwd", rejection: "absolute" },
  { path: "C:/windows", rejection: "absolute" },
  { path: "safe\0file", rejection: "nul-byte" },
  { path: "src\\app.ts", rejection: "backslash" },
  { path: "../secrets", rejection: "path-traversal" },
  { path: "./local", rejection: "dot-segment" },
  { path: "src//app.ts", rejection: "empty-segment" },
] as const satisfies readonly { path: string; rejection: WorkspacePathRejection }[];

const filesystemCalls = (path: string): readonly PrimitiveCall[] => [
  { kind: "read", path },
  { kind: "write", path, content: "content" },
  { kind: "edit", path, oldText: "old", newText: "new" },
];

test.each(invalidPaths)(
  "rejects $rejection paths for every filesystem primitive",
  async (invalid) => {
    for (const call of filesystemCalls(invalid.path)) {
      const result = await executePrimitive(call, new InMemoryWorkspace());

      expect(expectErr(result)).toMatchObject({
        _tag: "InvalidWorkspacePathError",
        path: invalid.path,
        rejection: invalid.rejection,
      });
    }
  },
);

test.each(everyRejection)("parseWorkspacePath reports $rejection for $path", (invalid) => {
  expect(expectErr(parseWorkspacePath(invalid.path))).toMatchObject({
    _tag: "InvalidWorkspacePathError",
    path: invalid.path,
    rejection: invalid.rejection,
  });
});

test("parseWorkspacePath accepts a relative path and brands it", () => {
  const parsed = parseWorkspacePath("src/app.ts");

  expect(parsed.isOk()).toBe(true);
  expect(parsed.unwrap()).toBe("src/app.ts");
});

test("the primitive registry contains exactly the four fixed actions", () => {
  expect(PRIMITIVE_KINDS).toEqual(["read", "write", "edit", "bash"]);
});
