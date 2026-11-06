import { expect, test, vi } from "vitest";
import { startExecOperation } from "../../../src/workspace/project/exec-operation.js";
import { FakeExecBackend } from "./fakes.js";

async function runToExit(command: string, backend?: "isolate" | "container") {
  const execBackend = new FakeExecBackend();

  const operation = startExecOperation(
    execBackend,
    { command, cwd: "/", timeoutMs: 1_000, backend },
    () => {},
  );

  await vi.waitFor(() => {
    expect(execBackend.handles).toHaveLength(1);
  });
  execBackend.handles[0]!.push({ name: "exit", exitCode: 3 });

  const reader = operation.events.getReader();

  while (!(await reader.read()).done);
}

test("an exec logs how it was requested, where it ran and how it ended", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});

  await runToExit("ls");
  await runToExit("make", "container");

  expect(log).toHaveBeenCalledWith(
    expect.objectContaining({
      event: "exec.finished",
      requested: "automatic",
      backend: "isolate",
      outcome: "exited",
      exitCode: 3,
    }),
  );
  expect(log).toHaveBeenCalledWith(
    expect.objectContaining({
      event: "exec.finished",
      requested: "container",
      backend: "container",
    }),
  );
});
