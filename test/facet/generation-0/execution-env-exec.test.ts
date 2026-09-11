import { afterEach, expect, test, vi } from "vitest";
import { MAX_EXEC_TIMEOUT_MS } from "../../../src/workspace/project/index.js";
import { makeFacetExecutionEnv } from "./execution-env-target.js";

/** Waits for the microtask queue this test's promises are chained on to drain. */
function tick(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

afterEach(() => {
  vi.useRealTimers();
});

test("invokes onStdout/onStderr before the terminal event resolves exec, and keeps channels separate", async () => {
  const { execBackend, env } = makeFacetExecutionEnv();
  const stdoutSeen: string[] = [];
  const stderrSeen: string[] = [];

  const execPromise = env.exec("build", {
    onStdout: (chunk) => {
      stdoutSeen.push(chunk);
    },
    onStderr: (chunk) => {
      stderrSeen.push(chunk);
    },
  });

  await tick();
  const handle = execBackend.handles[0]!;

  handle.push({ name: "stdout", data: new TextEncoder().encode("building\n") });
  await tick();
  expect(stdoutSeen).toEqual(["building\n"]);
  expect(stderrSeen).toEqual([]);

  handle.push({ name: "stderr", data: new TextEncoder().encode("warn\n") });
  await tick();
  expect(stderrSeen).toEqual(["warn\n"]);

  // Both callbacks fired while `execPromise` was still pending: this is the "before exit" guarantee.
  handle.push({ name: "exit", exitCode: 0 });
  await expect(execPromise).resolves.toEqual({
    ok: true,
    value: { stdout: "building\n", stderr: "warn\n", exitCode: 0 },
  });
});

test("aborting one of two concurrent commands kills only that operation", async () => {
  const { execBackend, env } = makeFacetExecutionEnv();
  const controllerA = new AbortController();
  const controllerB = new AbortController();

  const execA = env.exec("a", { abortSignal: controllerA.signal });
  const execB = env.exec("b", { abortSignal: controllerB.signal });
  await tick();
  const handleA = execBackend.handles[0]!;
  const handleB = execBackend.handles[1]!;

  controllerA.abort();
  await tick();
  expect(handleA.killCalls).toBe(1);
  expect(handleB.killCalls).toBe(0);

  await expect(execA).resolves.toMatchObject({ ok: false, error: { code: "aborted" } });

  handleB.push({ name: "exit", exitCode: 0 });
  await expect(execB).resolves.toEqual({
    ok: true,
    value: { stdout: "", stderr: "", exitCode: 0 },
  });
  expect(handleB.killCalls).toBe(0);
});

test("an omitted timeout defaults to the target's own maximum", async () => {
  const { execBackend, env } = makeFacetExecutionEnv();
  const execPromise = env.exec("sleep 1");
  await tick();
  expect(execBackend.requests[0]?.timeoutMs).toBe(MAX_EXEC_TIMEOUT_MS);
  execBackend.handles[0]!.push({ name: "exit", exitCode: 0 });
  await execPromise;
});

test("a timeout in seconds converts to milliseconds", async () => {
  const { execBackend, env } = makeFacetExecutionEnv();
  const execPromise = env.exec("sleep 1", { timeout: 0.05 });
  await tick();
  expect(execBackend.requests[0]?.timeoutMs).toBe(50);
  execBackend.handles[0]!.push({ name: "exit", exitCode: 0 });
  await execPromise;
});

test("an oversized timeout clamps to the target's maximum", async () => {
  const { execBackend, env } = makeFacetExecutionEnv();
  const execPromise = env.exec("sleep 1", { timeout: MAX_EXEC_TIMEOUT_MS });
  await tick();
  expect(execBackend.requests[0]?.timeoutMs).toBe(MAX_EXEC_TIMEOUT_MS);
  execBackend.handles[0]!.push({ name: "exit", exitCode: 0 });
  await execPromise;
});

test("a command that exceeds its timeout resolves an ExecutionError('timeout')", async () => {
  vi.useFakeTimers();
  const { env } = makeFacetExecutionEnv();
  const execPromise = env.exec("sleep 1", { timeout: 0.05 });
  await vi.advanceTimersByTimeAsync(50);
  await expect(execPromise).resolves.toMatchObject({ ok: false, error: { code: "timeout" } });
});

test("a hanging or rejecting backend kill does not stop an abort from resolving", async () => {
  const { execBackend, env } = makeFacetExecutionEnv();
  const controller = new AbortController();
  const execPromise = env.exec("x", { abortSignal: controller.signal });
  await tick();
  execBackend.handles[0]!.killBehavior = () => Promise.reject(new Error("kill failed"));

  controller.abort();
  await expect(execPromise).resolves.toMatchObject({ ok: false, error: { code: "aborted" } });
});
