import { expect, test } from "vitest";
import { WORKSPACE_COMMAND_TIMEOUT_MS } from "../../src/workspace-command-timeout.js";
import {
  executeProjectRemovalRequest,
  parseProjectRemovalRequest,
  planProjectRemovalRequest,
  type ProjectRemovalRequest,
  type WorkspaceOperations,
  type WorkspacePathKind,
  type CommandOutput,
} from "../../src/workspace/index.js";
import { projectDirectory } from "../../src/workspace-layout.js";
import { sampleProjectOne } from "../project-fixtures.js";

const request: ProjectRemovalRequest = {
  kind: "remove-project",
  projectId: sampleProjectOne.id,
};

class FakeOperations implements WorkspaceOperations {
  readonly sources: string[] = [];

  lstat(): Promise<WorkspacePathKind | undefined> {
    return Promise.resolve("directory");
  }

  readFile(): Promise<string> {
    return Promise.reject(new Error("removal does not read files"));
  }

  writeFile(): Promise<void> {
    return Promise.reject(new Error("removal does not write files"));
  }

  runCommand(source: string): Promise<CommandOutput> {
    this.sources.push(source);

    return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
  }
}

test("derives project removal paths from the project id", () => {
  const parsed = parseProjectRemovalRequest(request);

  expect(parsed).toEqual(request);

  if ("ok" in parsed) throw new Error("the valid removal request must parse");

  const plan = planProjectRemovalRequest(parsed);

  expect(plan.kind).toBe("run-command");
  expect(plan.cwd).toBe("/");
  expect(plan.timeoutMs).toBe(WORKSPACE_COMMAND_TIMEOUT_MS);
  expect(plan.source).toContain(projectDirectory(sampleProjectOne.id));
  expect(plan.source).toContain(`${projectDirectory(sampleProjectOne.id)}.provisioning`);
});

test("refuses malformed and harness removal requests", async () => {
  const operations = new FakeOperations();

  for (const value of [
    null,
    { kind: "remove-project", projectId: "../../etc" },
    { kind: "remove-project", projectId: "harness" },
    { kind: "remove-project", projectId: sampleProjectOne.id, extra: true },
  ]) {
    await expect(
      executeProjectRemovalRequest({ operations, request: value }),
    ).resolves.toMatchObject({
      ok: false,
    });
  }

  expect(operations.sources).toEqual([]);
});

test("removes only the clone and staging directory", async () => {
  const operations = new FakeOperations();

  await expect(executeProjectRemovalRequest({ operations, request })).resolves.toEqual({
    ok: true,
    result: { kind: "command", stdout: "", stderr: "", exitCode: 0 },
  });

  expect(operations.sources).toHaveLength(1);
  expect(operations.sources[0]).toContain(`rm -rf`);
  expect(operations.sources[0]).toContain(projectDirectory(sampleProjectOne.id));
  expect(operations.sources[0]).toContain(`${projectDirectory(sampleProjectOne.id)}.provisioning`);
  expect(operations.sources[0]).not.toContain("/workspace/harness");
});
