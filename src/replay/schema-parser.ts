import { isJsonObject, isJsonValue, parseJsonValue, type JsonObject, type JsonValue } from "../json.js";
import {
  REPLAY_SCHEMA_VERSION,
  ReplaySchemaError,
  type BashCall,
  type BashResult,
  type CapturedToolResult,
  type EditCall,
  type EditResult,
  type ObservableEffects,
  type PrimitiveCall,
  type PrimitiveResult,
  type ReadCall,
  type ReadResult,
  type RecordedModelResponse,
  type ReplaySession,
  type ReplayTurn,
  type WorkspaceFile,
  type WorkspaceTree,
  type WriteCall,
  type WriteResult,
} from "./schema.js";
function readRecord(value: JsonValue | undefined, path: string): JsonObject {
  if (!isJsonObject(value)) {
    throw new ReplaySchemaError(path, "must be an object");
  }
  return value;
}
function isString(value: JsonValue | undefined): value is string {
  return typeof value === "string";
}

function readString(value: JsonValue | undefined, path: string): string {
  if (!isString(value)) {
    throw new ReplaySchemaError(path, "must be a string");
  }
  return value;
}
function readNonEmptyString(value: JsonValue | undefined, path: string): string {
  const string = readString(value, path);
  if (string.length === 0) {
    throw new ReplaySchemaError(path, "must not be empty");
  }
  return string;
}

function readArray(value: JsonValue | undefined, path: string): readonly JsonValue[] {
  if (!Array.isArray(value)) {
    throw new ReplaySchemaError(path, "must be an array");
  }
  const array: readonly JsonValue[] = value;
  return array;
}
function isFiniteNumber(value: JsonValue | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function readFiniteNumber(value: JsonValue | undefined, path: string): number {
  if (!isFiniteNumber(value)) {
    throw new ReplaySchemaError(path, "must be a finite number");
  }
  return value;
}
function readInteger(value: JsonValue | undefined, path: string): number {
  const number = readFiniteNumber(value, path);
  if (!Number.isInteger(number)) {
    throw new ReplaySchemaError(path, "must be an integer");
  }
  return number;
}

function readWorkspacePath(value: JsonValue | undefined, path: string): string {
  const filePath = readNonEmptyString(value, path);
  if (
    filePath.startsWith("/") ||
    filePath.includes("\\") ||
    filePath.includes("\0") ||
    filePath.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new ReplaySchemaError(path, "must be a relative file path without dot segments");
  }
  return filePath;
}

function parseWorkspaceTree(value: JsonValue | undefined, path: string): WorkspaceTree {
  const entries = readArray(value, path).map((entry, index) => {
    const entryPath = `${path}[${index}]`;
    const record = readRecord(entry, entryPath);
    return {
      path: readWorkspacePath(record.path, `${entryPath}.path`),
      content: readString(record.content, `${entryPath}.content`),
    } satisfies WorkspaceFile;
  });

  const sorted = entries.toSorted((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    if (previous !== undefined && current !== undefined && previous.path === current.path) {
      throw new ReplaySchemaError(
        `${path}[${index}]`,
        `duplicate path ${JSON.stringify(current.path)}`,
      );
    }
  }
  return sorted;
}

function parsePrimitiveCall(value: JsonValue | undefined, path: string): PrimitiveCall {
  const record = readRecord(value, path);
  const kind = readNonEmptyString(record.kind, `${path}.kind`);
  switch (kind) {
    case "read": {
      const call: ReadCall = {
        kind,
        path: readWorkspacePath(record.path, `${path}.path`),
      };
      return call;
    }
    case "write": {
      const call: WriteCall = {
        kind,
        path: readWorkspacePath(record.path, `${path}.path`),
        content: readString(record.content, `${path}.content`),
      };
      return call;
    }
    case "edit": {
      const call: EditCall = {
        kind,
        path: readWorkspacePath(record.path, `${path}.path`),
        oldText: readString(record.oldText, `${path}.oldText`),
        newText: readString(record.newText, `${path}.newText`),
      };
      return call;
    }
    case "bash": {
      const call: BashCall = {
        kind,
        command: readNonEmptyString(record.command, `${path}.command`),
      };
      return call;
    }
    default:
      throw new ReplaySchemaError(`${path}.kind`, `unsupported primitive ${JSON.stringify(kind)}`);
  }
}

function parsePrimitiveResult(value: JsonValue | undefined, path: string): PrimitiveResult {
  const record = readRecord(value, path);
  const kind = readNonEmptyString(record.kind, `${path}.kind`);
  switch (kind) {
    case "read": {
      const result: ReadResult = {
        kind,
        content: readString(record.content, `${path}.content`),
      };
      return result;
    }
    case "write": {
      const result: WriteResult = {
        kind,
        bytesWritten: readInteger(record.bytesWritten, `${path}.bytesWritten`),
      };
      return result;
    }
    case "edit": {
      const result: EditResult = {
        kind,
        replacements: readInteger(record.replacements, `${path}.replacements`),
      };
      return result;
    }
    case "bash": {
      const result: BashResult = {
        kind,
        exitCode: readInteger(record.exitCode, `${path}.exitCode`),
        stdout: readString(record.stdout, `${path}.stdout`),
        stderr: readString(record.stderr, `${path}.stderr`),
      };
      return result;
    }
    default:
      throw new ReplaySchemaError(
        `${path}.kind`,
        `unsupported primitive result ${JSON.stringify(kind)}`,
      );
  }
}

function parseCapturedToolResult(value: JsonValue | undefined, path: string): CapturedToolResult {
  const record = readRecord(value, path);
  const call = parsePrimitiveCall(record.call, `${path}.call`);
  const result = parsePrimitiveResult(record.result, `${path}.result`);
  if (call.kind !== result.kind) {
    throw new ReplaySchemaError(path, "call and result primitives must match");
  }

  if (call.kind === "bash") {
    if (!("workspaceAfter" in record)) {
      throw new ReplaySchemaError(`${path}.workspaceAfter`, "is required for bash results");
    }
    return {
      call,
      result,
      workspaceAfter: parseWorkspaceTree(record.workspaceAfter, `${path}.workspaceAfter`),
    };
  }

  if ("workspaceAfter" in record) {
    throw new ReplaySchemaError(`${path}.workspaceAfter`, "is only valid for bash results");
  }
  return { call, result };
}

function parseModelResponse(value: JsonValue | undefined, path: string): RecordedModelResponse {
  const record = readRecord(value, path);
  return {
    requestId: readNonEmptyString(record.requestId, `${path}.requestId`),
    content: readString(record.content, `${path}.content`),
  };
}

function parseTurn(value: JsonValue | undefined, path: string): ReplayTurn {
  const record = readRecord(value, path);
  return {
    input: readString(record.input, `${path}.input`),
    modelResponses: readArray(record.modelResponses, `${path}.modelResponses`).map(
      (response, index) => parseModelResponse(response, `${path}.modelResponses[${index}]`),
    ),
    capturedToolResults: readArray(record.capturedToolResults, `${path}.capturedToolResults`).map(
      (result, index) => parseCapturedToolResult(result, `${path}.capturedToolResults[${index}]`),
    ),
  };
}

function parseObservableEffects(value: JsonValue | undefined, path: string): ObservableEffects {
  const record = readRecord(value, path);
  return {
    trace: readArray(record.trace, `${path}.trace`).map((call, index) =>
      parsePrimitiveCall(call, `${path}.trace[${index}]`),
    ),
    finalWorkspace: parseWorkspaceTree(record.finalWorkspace, `${path}.finalWorkspace`),
  };
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- persisted replay JSON enters here.
export function parseReplaySession(value: unknown): ReplaySession {
  if (!isJsonValue(value)) {
    throw new ReplaySchemaError("$", "must be a JSON value");
  }
  const record = readRecord(value, "$");
  const version = record.schemaVersion;
  if (version === undefined) {
    throw new ReplaySchemaError("$.schemaVersion", "is required");
  }
  if (version !== REPLAY_SCHEMA_VERSION) {
    throw new ReplaySchemaError(
      "$.schemaVersion",
      `unsupported version ${JSON.stringify(version)}`,
    );
  }

  const seed = readInteger(record.seed, "$.seed");
  if (seed < 0 || seed > 0xffff_ffff) {
    throw new ReplaySchemaError("$.seed", "must be an unsigned 32-bit integer");
  }

  const clockRecord = readRecord(record.clock, "$.clock");
  return {
    schemaVersion: REPLAY_SCHEMA_VERSION,
    name: readNonEmptyString(record.name, "$.name"),
    seed,
    clock: {
      nowMs: readFiniteNumber(clockRecord.nowMs, "$.clock.nowMs"),
    },
    initialWorkspace: parseWorkspaceTree(record.initialWorkspace, "$.initialWorkspace"),
    turns: readArray(record.turns, "$.turns").map((turn, index) =>
      parseTurn(turn, `$.turns[${index}]`),
    ),
    expectedEffects: parseObservableEffects(record.expectedEffects, "$.expectedEffects"),
  };
}

export function parseReplaySessionJson(json: string): ReplaySession {
  let value: JsonValue;
  try {
    value = parseJsonValue(JSON.parse(json));
  } catch (error) {
    if (error instanceof ReplaySchemaError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new ReplaySchemaError("$", `invalid JSON: ${detail}`);
  }
  return parseReplaySession(value);
}

export { REPLAY_SCHEMA_VERSION, ReplaySchemaError } from "./schema.js";
