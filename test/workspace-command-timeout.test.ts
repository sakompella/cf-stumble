import * as Cause from "effect/Cause";
import * as Result from "effect/Result";
import { expect, test } from "vitest";
import {
  boundedRpc,
  WorkspaceRpcRejected,
  type WorkspaceRpcFailure,
} from "../src/workspace-command-timeout.js";
import { resultOf } from "./effect-result.js";

test("a bounded RPC that exceeds its deadline fails with the tagged timeout error", async () => {
  const result = await resultOf(boundedRpc(() => new Promise<never>(() => {}), 20));

  expect(Result.isFailure(result)).toBe(true);

  if (Result.isFailure(result)) {
    expect(Cause.isTimeoutError(result.failure)).toBe(true);
    expect(result.failure._tag).toBe("TimeoutError");
  }
});

test("a bounded RPC rejection is a tagged failure that keeps its cause, even a timed-out message", async () => {
  const rejection = new Error("fatal: the remote clone timed out and left a partial tree");
  const result = await resultOf(boundedRpc(() => Promise.reject(rejection), 60_000));

  expect(Result.isFailure(result)).toBe(true);

  if (Result.isFailure(result)) {
    const failure: WorkspaceRpcFailure = result.failure;

    expect(Cause.isTimeoutError(failure)).toBe(false);
    expect(failure).toBeInstanceOf(WorkspaceRpcRejected);
    expect(failure).toMatchObject({ cause: rejection });
    expect(failure.message).toBe(rejection.message);
  }
});
