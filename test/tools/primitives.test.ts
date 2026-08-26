import { expect, test } from "vitest";
import {
  executePrimitive,
  InMemoryWorkspace,
  parseWorkspacePath,
  type PrimitiveResult,
  type WorkspaceFileContent,
  type WorkspacePath,
} from "../../src/tools/index.js";

function expectSuccess(result: PrimitiveResult): Extract<PrimitiveResult, { readonly ok: true }> {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(`expected success, got ${result.error.kind}`);
  }
  return result;
}

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

  expect(expectSuccess(result)).toEqual({ ok: true, kind: "read", content: "hello\n" });
});

test("read reports a missing file as a typed failure", async () => {
  const workspace = new InMemoryWorkspace();

  const result = await executePrimitive({ kind: "read", path: "missing.txt" }, workspace);

  expect(result).toEqual({
    ok: false,
    kind: "read",
    error: { kind: "file-not-found", path: "missing.txt" },
  });
});

test("read reports binary content as a typed failure", async () => {
  const workspace = new InMemoryWorkspace({
    files: [{ path: "image.bin", content: new Uint8Array([0, 255, 1]) }],
  });

  const result = await executePrimitive({ kind: "read", path: "image.bin" }, workspace);

  expect(result).toEqual({
    ok: false,
    kind: "read",
    error: { kind: "binary-file", path: "image.bin" },
  });
});

test("read reports workspace failures as typed failures", async () => {
  const result = await executePrimitive(
    { kind: "read", path: "README.md" },
    new FailingWorkspace("read"),
  );

  expect(result).toEqual({
    ok: false,
    kind: "read",
    error: { kind: "workspace-error", operation: "read", detail: "read failed" },
  });
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

  expect(expectSuccess(first)).toEqual({ ok: true, kind: "write", bytesWritten: 4 });
  expect(expectSuccess(second)).toEqual({ ok: true, kind: "write", bytesWritten: 5 });
  await expect(workspace.readFile(parseWorkspacePath("notes/today.txt"))).resolves.toBe("new\n");
  await expect(workspace.readFile(parseWorkspacePath("reports/weekly/summary.txt"))).resolves.toBe(
    "done\n",
  );
});

test("write reports workspace failures as typed failures", async () => {
  const result = await executePrimitive(
    { kind: "write", path: "README.md", content: "new\n" },
    new FailingWorkspace("write"),
  );

  expect(result).toEqual({
    ok: false,
    kind: "write",
    error: { kind: "workspace-error", operation: "write", detail: "write failed" },
  });
});
