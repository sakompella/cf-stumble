import { parseAddressedPath } from "./resolve.js";
import { fail, MAX_EXEC_TIMEOUT_MS, ok, type ProjectResult, type WriteMode } from "./types.js";

export const OPERATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9]+$/u;

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Boundary: the RPC write mode is untrusted; this is its type guard.
export function isWriteMode(value: unknown): value is WriteMode {
  return value === "overwrite" || value === "append" || value === "create-exclusive";
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Boundary: the RPC `timeoutMs` field is untrusted; this parses it.
function resolveTimeout(input: unknown): ProjectResult<number> {
  if (input === undefined) return ok(MAX_EXEC_TIMEOUT_MS);
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Boundary: the RPC `timeoutMs` field is untrusted.
  if (typeof input !== "number" || !Number.isFinite(input) || input <= 0) {
    return fail("invalid-request");
  }
  return ok(Math.min(input, MAX_EXEC_TIMEOUT_MS));
}

export interface ParsedStartExecInput {
  command: string;
  cwdSegments: readonly string[];
  timeoutMs: number;
}

const START_EXEC_KEYS = new Set(["command", "cwd", "timeoutMs"]);

/** Parses `startExec`'s RPC input: a `command`, and optional `cwd` and `timeoutMs`, nothing else. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This is the RPC boundary for `startExec`; every field is parsed below.
export function parseStartExecInput(input: unknown): ProjectResult<ParsedStartExecInput> {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Boundary: the RPC input shape is untrusted.
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return fail("invalid-request");
  }
  for (const key of Object.keys(input))
    if (!START_EXEC_KEYS.has(key)) return fail("invalid-request");
  if (!("command" in input)) return fail("invalid-request");

  const { command } = input;
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Boundary: the RPC `command` field is untrusted.
  if (typeof command !== "string" || command.length === 0) return fail("invalid-request");

  const cwd = "cwd" in input ? input.cwd : undefined;
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Boundary: the RPC `cwd` field is untrusted.
  if (cwd !== undefined && typeof cwd !== "string") return fail("invalid-request");

  const cwdSegments = parseAddressedPath(cwd ?? "/");
  if (!cwdSegments.ok) return cwdSegments;

  const timeoutMs = resolveTimeout("timeoutMs" in input ? input.timeoutMs : undefined);
  if (!timeoutMs.ok) return timeoutMs;

  return ok({ command, cwdSegments: cwdSegments.value, timeoutMs: timeoutMs.value });
}
