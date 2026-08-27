import { expect, test } from "vitest";
import {
  BinaryFileError,
  executePrimitive,
  InMemoryWorkspace,
  parseWorkspacePath,
  WorkspaceFileNotFoundError,
  WorkspaceOperationError,
  type WorkspaceFileContent,
  type WorkspacePath,
} from "../../src/tools/index.js";
import { expectErr, expectOk } from "../support/result.js";

class FailingWorkspace extends InMemoryWorkspace {
  private readonly operation: "read" | "write";

  constructor(operation: "read" | "write") {
    super();
    this.operation = operation;
  }

  override readFile(path: WorkspacePath): Promise<WorkspaceFileContent | undefined> {
    if (this.operation === "read") {
      return Promise.reject(new Error("read failed"));
    }
    return super.readFile(path);
  }

  override writeFile(path: WorkspacePath, content: string): Promise<void> {
    if (this.operation === "write") {
      return Promise.reject(new Error("write failed"));
    }
    return super.writeFile(path, content);
  }
}

test("read returns the text content of an existing file", async () => {
  const workspace = new InMemoryWorkspace({
    files: [{ path: "README.md", content: "hello\n" }],
  });

  const result = await executePrimitive({ kind: "read", path: "README.md" }, workspace);

  expect(expectOk(result)).toEqual({ kind: "read", content: "hello\n" });
});

test("read reports a missing file as a typed failure", async () => {
  const workspace = new InMemoryWorkspace();

  const result = await executePrimitive({ kind: "read", path: "missing.txt" }, workspace);

  const error = expectErr(result);
  expect(WorkspaceFileNotFoundError.is(error)).toBe(true);
  expect(error).toMatchObject({ _tag: "WorkspaceFileNotFoundError", path: "missing.txt" });
});

test("read reports binary content as a typed failure", async () => {
  const workspace = new InMemoryWorkspace({
    files: [{ path: "image.bin", content: new Uint8Array([0, 255, 1]) }],
  });

  const result = await executePrimitive({ kind: "read", path: "image.bin" }, workspace);

  const error = expectErr(result);
  expect(BinaryFileError.is(error)).toBe(true);
  expect(error).toMatchObject({ _tag: "BinaryFileError", path: "image.bin" });
});

test("read reports workspace failures as typed failures, keeping the cause", async () => {
  const result = await executePrimitive(
    { kind: "read", path: "README.md" },
    new FailingWorkspace("read"),
  );

  const error = expectErr(result);
  expect(WorkspaceOperationError.is(error)).toBe(true);
  expect(error).toMatchObject({
    _tag: "WorkspaceOperationError",
    operation: "read",
    detail: "read failed",
  });
  // The thrown Error is preserved rather than flattened into a string, so a stack survives.
  expect(WorkspaceOperationError.is(error) ? error.cause : undefined).toBeInstanceOf(Error);
});

test("write creates parent directories and overwrites existing text", async () => {
  const workspace = new InMemoryWorkspace({
    files: [{ path: "notes/today.txt", content: "old\n" }],
  });

  const first = await executePrimitive(
    { kind: "write", path: "notes/today.txt", content: "new\n" },
    workspace,
  );
  const second = await executePrimitive(
    { kind: "write", path: "reports/weekly/summary.txt", content: "done\n" },
    workspace,
  );

  expect(expectOk(first)).toEqual({ kind: "write", bytesWritten: 4 });
  expect(expectOk(second)).toEqual({ kind: "write", bytesWritten: 5 });
  await expect(workspace.readFile(parseWorkspacePath("notes/today.txt").unwrap())).resolves.toBe(
    "new\n",
  );
  await expect(
    workspace.readFile(parseWorkspacePath("reports/weekly/summary.txt").unwrap()),
  ).resolves.toBe("done\n");
});

test("write reports workspace failures as typed failures", async () => {
  const result = await executePrimitive(
    { kind: "write", path: "README.md", content: "new\n" },
    new FailingWorkspace("write"),
  );

  expect(expectErr(result)).toMatchObject({
    _tag: "WorkspaceOperationError",
    operation: "write",
    detail: "write failed",
  });
});
