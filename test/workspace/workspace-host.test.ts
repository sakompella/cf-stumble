import { expect, test } from "vitest";
import {
  executeWorkspaceRequest,
  parseWorkspaceRequest,
  planWorkspaceRequest,
  WorkspaceHost,
  type CommandOutput,
  type WorkspaceConfiguration,
  type WorkspaceOperations,
} from "../../src/workspace/index.js";

const configuration = {
  root: "/project",
  commands: { check: "pnpm verify" },
} as const satisfies WorkspaceConfiguration;

type FailurePoint = keyof WorkspaceOperations;

class FakeWorkspace implements WorkspaceOperations {
  readonly calls: string[] = [];
  readonly files = new Map<string, string>([["/project/readme.md", "before"]]);
  readonly directories = new Set(["/project", "/project/src"]);
  readonly symlinks = new Set<string>();
  private readonly failAt: FailurePoint | undefined;

  constructor(failAt?: FailurePoint) {
    this.failAt = failAt;
  }

  lstat(path: string): Promise<"file" | "directory" | "symbolic-link" | undefined> {
    this.calls.push(`lstat:${path}`);
    if (this.failAt === "lstat") return Promise.reject(new Error("fake lstat failure"));
    if (this.symlinks.has(path)) return Promise.resolve("symbolic-link");
    if (this.directories.has(path)) return Promise.resolve("directory");
    return Promise.resolve(this.files.has(path) ? "file" : undefined);
  }

  readFile(path: string): Promise<string> {
    this.calls.push(`read:${path}`);
    if (this.failAt === "readFile") return Promise.reject(new Error("fake read failure"));
    const content = this.files.get(path);
    return content === undefined
      ? Promise.reject(new Error("missing file"))
      : Promise.resolve(content);
  }

  writeFile(path: string, content: string): Promise<void> {
    this.calls.push(`write:${path}:${content}`);
    if (this.failAt === "writeFile") return Promise.reject(new Error("fake write failure"));
    this.files.set(path, content);
    return Promise.resolve();
  }

  listFiles(path: string): Promise<readonly string[]> {
    this.calls.push(`list:${path}`);
    if (this.failAt === "listFiles") return Promise.reject(new Error("fake list failure"));
    return this.directories.has(path)
      ? Promise.resolve(["src", "readme.md"])
      : Promise.reject(new Error("missing directory"));
  }

  runCommand(source: string, cwd: string): Promise<CommandOutput> {
    this.calls.push(`command:${source}:${cwd}`);
    if (this.failAt === "runCommand") return Promise.reject(new Error("fake command failure"));
    return Promise.resolve({ stdout: `${source} output`, stderr: "", exitCode: 7 });
  }
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This helper passes test values to the public parsing boundary.
function execute(fake: FakeWorkspace, request: unknown) {
  return executeWorkspaceRequest({ configuration, operations: fake, request });
}

test("reads, writes, and lists only below the configured project root", async () => {
  const fake = new FakeWorkspace();

  await expect(execute(fake, { kind: "read-file", path: "readme.md" })).resolves.toEqual({
    ok: true,
    result: { kind: "file", content: "before" },
  });
  await expect(
    execute(fake, { kind: "write-file", path: "src/new.ts", content: "export {};" }),
  ).resolves.toEqual({ ok: true, result: { kind: "written" } });
  await expect(execute(fake, { kind: "list-files", path: "" })).resolves.toEqual({
    ok: true,
    result: { kind: "files", entries: ["src", "readme.md"] },
  });

  expect(fake.calls).toContain("read:/project/readme.md");
  expect(fake.calls).toContain("write:/project/src/new.ts:export {};");
  expect(fake.calls).toContain("list:/project");
});

test("runs only configured commands and provides a fixed git diff", async () => {
  const fake = new FakeWorkspace();

  await expect(execute(fake, { kind: "run-command", command: "check" })).resolves.toEqual({
    ok: true,
    result: { kind: "command", stdout: "pnpm verify output", stderr: "", exitCode: 7 },
  });
  await expect(execute(fake, { kind: "git-diff" })).resolves.toEqual({
    ok: true,
    result: {
      kind: "git-diff",
      stdout: "git diff --no-ext-diff output",
      stderr: "",
      exitCode: 7,
    },
  });

  expect(fake.calls).toEqual([
    "command:pnpm verify:/project",
    "command:git diff --no-ext-diff:/project",
  ]);
});

test("rejects malformed requests, path escapes, and caller supplied commands", async () => {
  const fake = new FakeWorkspace();

  for (const [request, code] of [
    [null, "invalid-request"],
    [{ kind: "read-file" }, "invalid-request"],
    [{ kind: "read-file", path: "readme.md", extra: true }, "invalid-request"],
    [{ kind: "read-file", path: "../secret" }, "path-outside-root"],
    [{ kind: "read-file", path: "/secret" }, "path-outside-root"],
    [{ kind: "read-file", path: "src\\secret" }, "path-outside-root"],
    [{ kind: "run-command", command: "check", source: "whoami" }, "invalid-request"],
  ] as const) {
    await expect(execute(fake, request)).resolves.toEqual({ ok: false, error: { code } });
  }
  await expect(execute(fake, { kind: "run-command", command: "whoami" })).resolves.toEqual({
    ok: false,
    error: { code: "unknown-command" },
  });
  expect(fake.calls).toEqual([]);
});

test("rejects paths containing a symbolic link before file operations", async () => {
  const fake = new FakeWorkspace();
  fake.symlinks.add("/project/src");

  for (const request of [
    { kind: "read-file", path: "src/readme.md" },
    { kind: "write-file", path: "src/new.ts", content: "x" },
    { kind: "list-files", path: "src" },
  ] as const) {
    await expect(execute(fake, request)).resolves.toEqual({
      ok: false,
      error: { code: "path-outside-root" },
    });
  }
  expect(fake.calls.every((call) => call.startsWith("lstat:"))).toBe(true);
});

test.each<readonly [FailurePoint, unknown]>([
  ["lstat", { kind: "read-file", path: "readme.md" }],
  ["readFile", { kind: "read-file", path: "readme.md" }],
  ["writeFile", { kind: "write-file", path: "readme.md", content: "after" }],
  ["listFiles", { kind: "list-files", path: "" }],
  ["runCommand", { kind: "run-command", command: "check" }],
])("redacts a %s failure", async (failurePoint, request) => {
  await expect(execute(new FakeWorkspace(failurePoint), request)).resolves.toEqual({
    ok: false,
    error: { code: "workspace-unavailable" },
  });
});

test("returns plain cloneable values and exposes no raw Computer RPC method", async () => {
  const result = await execute(new FakeWorkspace(), { kind: "list-files", path: "" });

  expect(structuredClone(result)).toEqual(result);
  expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
  expect(Object.getOwnPropertyNames(WorkspaceHost.prototype).toSorted()).toEqual([
    "build",
    "constructor",
    "execute",
    "fetch",
  ]);
});

test("keeps request parsing and planning as pure decisions", () => {
  const request = parseWorkspaceRequest({ kind: "run-command", command: "check" });
  if ("ok" in request) throw new Error("valid request must parse");

  expect(planWorkspaceRequest(configuration, request)).toEqual({
    kind: "run-command",
    source: "pnpm verify",
    cwd: "/project",
  });
});
