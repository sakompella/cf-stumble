import { expect, test } from "vitest";
import {
  InMemoryWorkspace,
  parseWorkspacePath,
  type WorkspaceCommandResult,
} from "../../src/tools/index.js";

test("the in-memory workspace reads, overwrites, creates parents, and lists files", async () => {
  const workspace = new InMemoryWorkspace({
    files: [{ path: "src/app.ts", content: "const answer = 1;\n" }],
  });
  const appPath = parseWorkspacePath("src/app.ts");
  const notePath = parseWorkspacePath("notes/today.txt");

  expect(await workspace.exists(appPath)).toBe(true);
  expect(await workspace.readFile(appPath)).toBe("const answer = 1;\n");

  await workspace.writeFile(notePath, "first\n");
  await workspace.writeFile(notePath, "second\n");

  expect(await workspace.readFile(notePath)).toBe("second\n");
  expect(await workspace.listFiles()).toEqual([notePath, appPath]);
});

test("the in-memory workspace exposes configured command outcomes", async () => {
  const commandResult: WorkspaceCommandResult = {
    status: "completed",
    exitCode: 7,
    stdout: "partial\n",
    stderr: "failed\n",
  };
  const workspace = new InMemoryWorkspace({
    executeCommand: (command, options) => {
      expect(command).toBe("false");
      expect(options.timeoutMs).toBe(250);
      return commandResult;
    },
  });

  await expect(
    workspace.execute("false", { timeoutMs: 250 }),
  ).resolves.toEqual(commandResult);
});

test("the in-memory workspace preserves binary content for the read primitive to reject", async () => {
  const workspace = new InMemoryWorkspace({
    files: [{ path: "image.bin", content: new Uint8Array([0, 255, 1]) }],
  });

  await expect(workspace.readFile(parseWorkspacePath("image.bin"))).resolves.toEqual(
    new Uint8Array([0, 255, 1]),
  );
});
