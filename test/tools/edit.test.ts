import { expect, test } from "vitest";
import {
  executePrimitive,
  InMemoryWorkspace,
  parseWorkspacePath,
  type WorkspaceFileContent,
  type WorkspacePath,
} from "../../src/tools/index.js";
import { expectErr, expectOk } from "../support/result.js";

class FailingEditWorkspace extends InMemoryWorkspace {
  override readFile(_path: WorkspacePath): Promise<WorkspaceFileContent | undefined> {
    return Promise.reject(new Error("edit read failed"));
  }
}

test("edit replaces the one exact match and reports one replacement", async () => {
  const workspace = new InMemoryWorkspace({
    files: [{ path: "src/app.ts", content: "const answer = 1;\n" }],
  });

  const result = await executePrimitive(
    { kind: "edit", path: "src/app.ts", oldText: "1", newText: "42" },
    workspace,
  );

  expect(expectOk(result)).toEqual({ kind: "edit", replacements: 1 });
  await expect(workspace.readFile(parseWorkspacePath("src/app.ts").unwrap())).resolves.toBe(
    "const answer = 42;\n",
  );
});

test("edit reports no match and leaves the file unchanged", async () => {
  const workspace = new InMemoryWorkspace({
    files: [{ path: "policy.txt", content: "allow read\n" }],
  });

  const result = await executePrimitive(
    { kind: "edit", path: "policy.txt", oldText: "allow bash", newText: "deny bash" },
    workspace,
  );

  expect(expectErr(result)).toMatchObject({
    _tag: "EditNoMatchError",
    path: "policy.txt",
    oldText: "allow bash",
  });
  await expect(workspace.readFile(parseWorkspacePath("policy.txt").unwrap())).resolves.toBe(
    "allow read\n",
  );
});

test("edit rejects an ambiguous match instead of choosing the first", async () => {
  const workspace = new InMemoryWorkspace({
    files: [{ path: "policy.txt", content: "allow read\nallow read\n" }],
  });

  const result = await executePrimitive(
    { kind: "edit", path: "policy.txt", oldText: "allow read", newText: "deny read" },
    workspace,
  );

  expect(expectErr(result)).toMatchObject({
    _tag: "EditAmbiguousMatchError",
    path: "policy.txt",
    oldText: "allow read",
    occurrences: 2,
  });
  await expect(workspace.readFile(parseWorkspacePath("policy.txt").unwrap())).resolves.toBe(
    "allow read\nallow read\n",
  );
});

test("edit reports a missing file as a typed failure", async () => {
  const result = await executePrimitive(
    { kind: "edit", path: "missing.txt", oldText: "old", newText: "new" },
    new InMemoryWorkspace(),
  );

  expect(expectErr(result)).toMatchObject({
    _tag: "WorkspaceFileNotFoundError",
    path: "missing.txt",
  });
});

test("edit reports binary content as a typed failure", async () => {
  const result = await executePrimitive(
    { kind: "edit", path: "image.bin", oldText: "old", newText: "new" },
    new InMemoryWorkspace({ files: [{ path: "image.bin", content: new Uint8Array([0, 1]) }] }),
  );

  expect(expectErr(result)).toMatchObject({ _tag: "BinaryFileError", path: "image.bin" });
});

test("edit reports workspace failures as typed failures", async () => {
  const result = await executePrimitive(
    { kind: "edit", path: "policy.txt", oldText: "old", newText: "new" },
    new FailingEditWorkspace(),
  );

  expect(expectErr(result)).toMatchObject({
    _tag: "WorkspaceOperationError",
    operation: "edit",
    detail: "edit read failed",
  });
});

test("edit rejects an empty search string as a typed failure", async () => {
  const result = await executePrimitive(
    { kind: "edit", path: "policy.txt", oldText: "", newText: "changed" },
    new InMemoryWorkspace({ files: [{ path: "policy.txt", content: "unchanged" }] }),
  );

  expect(expectErr(result)).toMatchObject({ _tag: "EmptyEditSearchError", path: "policy.txt" });
});
