import { expect, test } from "vitest";
import { failedTurn } from "../../src/validation/preflight-results.js";
import {
  BinaryFileError,
  CommandTimeoutError,
  EditAmbiguousMatchError,
  EditNoMatchError,
  EmptyEditSearchError,
  InvalidCommandTimeoutError,
  InvalidWorkspacePathError,
  WorkspaceFileNotFoundError,
  WorkspaceOperationError,
  type PrimitiveError,
} from "../../src/tools/index.js";

/**
 * The preflight boundary for primitive failures.
 *
 * The split under test is the reason preflight has three outcomes: a harness fault must not be
 * recorded as a candidate regression, so it is INCONCLUSIVE. Every `PrimitiveError` variant is
 * listed here, so a new variant with no entry shows up as a missing case rather than silently
 * inheriting a verdict.
 */
const candidateFaults: readonly { readonly error: PrimitiveError; readonly detail: string }[] = [
  {
    error: new InvalidWorkspacePathError({ path: "../escape", rejection: "path-traversal" }),
    detail: 'invalid path "../escape" (path-traversal)',
  },
  {
    error: new WorkspaceFileNotFoundError({ path: "missing.txt" }),
    detail: 'file "missing.txt" was not found',
  },
  {
    error: new BinaryFileError({ path: "image.bin" }),
    detail: 'file "image.bin" is binary',
  },
  {
    error: new EmptyEditSearchError({ path: "policy.txt" }),
    detail: "edit search text must not be empty",
  },
  {
    error: new EditNoMatchError({ path: "policy.txt", oldText: "absent" }),
    detail: "expected exactly one match, found none",
  },
  {
    error: new EditAmbiguousMatchError({ path: "policy.txt", oldText: "dup", occurrences: 3 }),
    detail: "expected exactly one match, found 3",
  },
];

const harnessFaults: readonly { readonly error: PrimitiveError; readonly detail: string }[] = [
  {
    error: new WorkspaceOperationError({ operation: "read", cause: new Error("disk gone") }),
    detail: "workspace error during read: disk gone",
  },
  {
    error: new CommandTimeoutError({
      command: "sleep 10",
      timeoutMs: 25,
      stdout: "",
      stderr: "",
    }),
    detail: "workspace command timed out after 25ms",
  },
  {
    error: new InvalidCommandTimeoutError({ timeoutMs: 0 }),
    detail: "invalid bash timeout 0",
  },
];

test.each(candidateFaults)("$error._tag is the candidate's fault, so it FAILs", (entry) => {
  expect(
    failedTurn("read", {
      kind: "primitive-failure",
      call: { kind: "read", path: "p" },
      error: entry.error,
    }),
  ).toEqual({ capability: "read", status: "FAIL", detail: `read: ${entry.detail}` });
});

test.each(harnessFaults)("$error._tag is the harness's fault, so it is INCONCLUSIVE", (entry) => {
  expect(
    failedTurn("bash", {
      kind: "primitive-failure",
      call: { kind: "bash", command: "c" },
      error: entry.error,
    }),
  ).toEqual({ capability: "bash", status: "INCONCLUSIVE", detail: `bash: ${entry.detail}` });
});

test("every PrimitiveError variant has a verdict recorded above", () => {
  // TaggedError sets `name` to the tag, so this reads the same value without the private-looking
  // `_tag` accessor.
  const covered = new Set([...candidateFaults, ...harnessFaults].map((entry) => entry.error.name));

  expect([...covered].toSorted()).toEqual([
    "BinaryFileError",
    "CommandTimeoutError",
    "EditAmbiguousMatchError",
    "EditNoMatchError",
    "EmptyEditSearchError",
    "InvalidCommandTimeoutError",
    "InvalidWorkspacePathError",
    "WorkspaceFileNotFoundError",
    "WorkspaceOperationError",
  ]);
});

test("a workspace operation error keeps the cause for debugging without leaking it to preflight", () => {
  const cause = new Error("disk gone");
  const error = new WorkspaceOperationError({ operation: "write", cause });

  expect(error.cause).toBe(cause);
  expect(error.message).toBe("workspace error during write: disk gone");

  const check = failedTurn("write", {
    kind: "primitive-failure",
    call: { kind: "write", path: "p", content: "c" },
    error,
  });

  // The preflight detail is built at the boundary, not read off the error's own message.
  expect(check).toEqual({
    capability: "write",
    status: "INCONCLUSIVE",
    detail: "write: workspace error during write: disk gone",
  });
});
