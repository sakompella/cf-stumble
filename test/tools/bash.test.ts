import { expect, test } from "vitest";
import {
  executePrimitive,
  InMemoryWorkspace,
  type PrimitiveResult,
} from "../../src/tools/index.js";

function expectSuccess(result: PrimitiveResult): Extract<PrimitiveResult, { readonly ok: true }> {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(`expected success, got ${result.error.kind}`);
  }
  return result;
}

test("bash returns stdout, stderr, and a zero exit code", async () => {
  const result = await executePrimitive(
    { kind: "bash", command: "printf 'ok\\n'" },
    new InMemoryWorkspace({
      executeCommand: (command, options) => {
        expect(command).toBe("printf 'ok\\n'");
        expect(options.timeoutMs).toBe(500);
        return { status: "completed", exitCode: 0, stdout: "ok\n", stderr: "" };
      },
    }),
    { bashTimeoutMs: 500 },
  );

  expect(expectSuccess(result)).toEqual({
    ok: true,
    kind: "bash",
    exitCode: 0,
    stdout: "ok\n",
    stderr: "",
  });
});

test("bash exposes a non-zero exit code as a result rather than an exception", async () => {
  const result = await executePrimitive(
    { kind: "bash", command: "false" },
    new InMemoryWorkspace({
      executeCommand: () => ({
        status: "completed",
        exitCode: 17,
        stdout: "",
        stderr: "bad command\n",
      }),
    }),
  );

  expect(expectSuccess(result)).toEqual({
    ok: true,
    kind: "bash",
    exitCode: 17,
    stdout: "",
    stderr: "bad command\n",
  });
});

test("bash returns timeout as a distinct typed outcome", async () => {
  const result = await executePrimitive(
    { kind: "bash", command: "sleep 10" },
    new InMemoryWorkspace({
      executeCommand: (_command, options) => ({
        status: "timed-out",
        stdout: "before timeout",
        stderr: `deadline ${options.timeoutMs}`,
      }),
    }),
    { bashTimeoutMs: 25 },
  );

  expect(result).toEqual({
    ok: false,
    kind: "bash",
    error: {
      kind: "timeout",
      command: "sleep 10",
      timeoutMs: 25,
      stdout: "before timeout",
      stderr: "deadline 25",
    },
  });
});

test("bash reports command-execution failures as typed failures", async () => {
  const result = await executePrimitive(
    { kind: "bash", command: "printf 'ok'" },
    new InMemoryWorkspace({
      executeCommand: () => {
        throw new Error("shell unavailable");
      },
    }),
  );

  expect(result).toEqual({
    ok: false,
    kind: "bash",
    error: { kind: "workspace-error", operation: "bash", detail: "shell unavailable" },
  });
});

test("bash rejects an invalid timeout as a typed failure", async () => {
  const result = await executePrimitive(
    { kind: "bash", command: "true" },
    new InMemoryWorkspace(),
    { bashTimeoutMs: 0 },
  );

  expect(result).toEqual({
    ok: false,
    kind: "bash",
    error: { kind: "invalid-timeout", timeoutMs: 0 },
  });
});
