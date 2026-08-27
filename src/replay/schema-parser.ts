import { Result } from "better-result";
import { parseJsonValue, type JsonValue } from "../json.js";
import {
  readArray,
  readFiniteNumber,
  readInteger,
  readNonEmptyString,
  readRecord,
  readString,
} from "./json-readers.js";
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

type JsonField = JsonValue | undefined;
type SchemaResult<T> = Result<T, ReplaySchemaError>;

function schemaError(path: string, condition: string): SchemaResult<never> {
  return Result.err(new ReplaySchemaError({ path, condition }));
}

function readWorkspacePath(value: JsonField, path: string): Result<string, ReplaySchemaError> {
  return Result.gen(function* () {
    const filePath = yield* readNonEmptyString(value, path);
    if (
      filePath.startsWith("/") ||
      filePath.includes("\\") ||
      filePath.includes("\0") ||
      filePath.split("/").some((part) => part === "" || part === "." || part === "..")
    ) {
      return schemaError(path, "must be a relative file path without dot segments");
    }
    return Result.ok(filePath);
  });
}

function parseWorkspaceTree(
  value: JsonField,
  path: string,
): Result<WorkspaceTree, ReplaySchemaError> {
  return Result.gen(function* () {
    const values = yield* readArray(value, path);
    const entries: WorkspaceFile[] = [];
    for (let index = 0; index < values.length; index += 1) {
      const entryPath = `${path}[${index}]`;
      const record = yield* readRecord(values[index], entryPath);
      entries.push({
        path: yield* readWorkspacePath(record.path, `${entryPath}.path`),
        content: yield* readString(record.content, `${entryPath}.content`),
      });
    }

    const sorted = entries.toSorted((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    );
    for (let index = 1; index < sorted.length; index += 1) {
      const previous = sorted[index - 1];
      const current = sorted[index];
      if (previous !== undefined && current !== undefined && previous.path === current.path) {
        return schemaError(`${path}[${index}]`, `duplicate path ${JSON.stringify(current.path)}`);
      }
    }
    return Result.ok<WorkspaceTree>(sorted);
  });
}

function parsePrimitiveCall(
  value: JsonField,
  path: string,
): Result<PrimitiveCall, ReplaySchemaError> {
  return Result.gen(function* () {
    const record = yield* readRecord(value, path);
    const kind = yield* readNonEmptyString(record.kind, `${path}.kind`);
    switch (kind) {
      case "read":
        return Result.ok<PrimitiveCall>({
          kind,
          path: yield* readWorkspacePath(record.path, `${path}.path`),
        } satisfies ReadCall);
      case "write":
        return Result.ok<PrimitiveCall>({
          kind,
          path: yield* readWorkspacePath(record.path, `${path}.path`),
          content: yield* readString(record.content, `${path}.content`),
        } satisfies WriteCall);
      case "edit":
        return Result.ok<PrimitiveCall>({
          kind,
          path: yield* readWorkspacePath(record.path, `${path}.path`),
          oldText: yield* readString(record.oldText, `${path}.oldText`),
          newText: yield* readString(record.newText, `${path}.newText`),
        } satisfies EditCall);
      case "bash":
        return Result.ok<PrimitiveCall>({
          kind,
          command: yield* readNonEmptyString(record.command, `${path}.command`),
        } satisfies BashCall);
      default:
        return schemaError(`${path}.kind`, `unsupported primitive ${JSON.stringify(kind)}`);
    }
  });
}

function parsePrimitiveResult(
  value: JsonField,
  path: string,
): Result<PrimitiveResult, ReplaySchemaError> {
  return Result.gen(function* () {
    const record = yield* readRecord(value, path);
    const kind = yield* readNonEmptyString(record.kind, `${path}.kind`);
    switch (kind) {
      case "read":
        return Result.ok<PrimitiveResult>({
          kind,
          content: yield* readString(record.content, `${path}.content`),
        } satisfies ReadResult);
      case "write":
        return Result.ok<PrimitiveResult>({
          kind,
          bytesWritten: yield* readInteger(record.bytesWritten, `${path}.bytesWritten`),
        } satisfies WriteResult);
      case "edit":
        return Result.ok<PrimitiveResult>({
          kind,
          replacements: yield* readInteger(record.replacements, `${path}.replacements`),
        } satisfies EditResult);
      case "bash":
        return Result.ok<PrimitiveResult>({
          kind,
          exitCode: yield* readInteger(record.exitCode, `${path}.exitCode`),
          stdout: yield* readString(record.stdout, `${path}.stdout`),
          stderr: yield* readString(record.stderr, `${path}.stderr`),
        } satisfies BashResult);
      default:
        return schemaError(`${path}.kind`, `unsupported primitive result ${JSON.stringify(kind)}`);
    }
  });
}

function parseCapturedToolResult(value: JsonField, path: string): SchemaResult<CapturedToolResult> {
  return Result.gen(function* () {
    const record = yield* readRecord(value, path);
    const call = yield* parsePrimitiveCall(record.call, `${path}.call`);
    const result = yield* parsePrimitiveResult(record.result, `${path}.result`);
    if (call.kind !== result.kind) {
      return schemaError(path, "call and result primitives must match");
    }

    if (call.kind === "bash") {
      if (!("workspaceAfter" in record)) {
        return schemaError(`${path}.workspaceAfter`, "is required for bash results");
      }
      return Result.ok<CapturedToolResult>({
        call,
        result,
        workspaceAfter: yield* parseWorkspaceTree(record.workspaceAfter, `${path}.workspaceAfter`),
      });
    }

    if ("workspaceAfter" in record) {
      return schemaError(`${path}.workspaceAfter`, "is only valid for bash results");
    }
    return Result.ok<CapturedToolResult>({ call, result });
  });
}

function parseModelResponse(value: JsonField, path: string): SchemaResult<RecordedModelResponse> {
  return Result.gen(function* () {
    const record = yield* readRecord(value, path);
    return Result.ok({
      requestId: yield* readNonEmptyString(record.requestId, `${path}.requestId`),
      content: yield* readString(record.content, `${path}.content`),
    });
  });
}

function parseTurn(value: JsonField, path: string): Result<ReplayTurn, ReplaySchemaError> {
  return Result.gen(function* () {
    const record = yield* readRecord(value, path);
    const modelResponseValues = yield* readArray(record.modelResponses, `${path}.modelResponses`);
    const modelResponses: RecordedModelResponse[] = [];
    for (let index = 0; index < modelResponseValues.length; index += 1) {
      modelResponses.push(
        yield* parseModelResponse(modelResponseValues[index], `${path}.modelResponses[${index}]`),
      );
    }

    const capturedResultValues = yield* readArray(
      record.capturedToolResults,
      `${path}.capturedToolResults`,
    );
    const capturedToolResults: CapturedToolResult[] = [];
    for (let index = 0; index < capturedResultValues.length; index += 1) {
      capturedToolResults.push(
        yield* parseCapturedToolResult(
          capturedResultValues[index],
          `${path}.capturedToolResults[${index}]`,
        ),
      );
    }

    return Result.ok<ReplayTurn>({
      input: yield* readString(record.input, `${path}.input`),
      modelResponses,
      capturedToolResults,
    });
  });
}

function parseObservableEffects(value: JsonField, path: string): SchemaResult<ObservableEffects> {
  return Result.gen(function* () {
    const record = yield* readRecord(value, path);
    const traceValues = yield* readArray(record.trace, `${path}.trace`);
    const trace: PrimitiveCall[] = [];
    for (let index = 0; index < traceValues.length; index += 1) {
      trace.push(yield* parsePrimitiveCall(traceValues[index], `${path}.trace[${index}]`));
    }
    return Result.ok<ObservableEffects>({
      trace,
      finalWorkspace: yield* parseWorkspaceTree(record.finalWorkspace, `${path}.finalWorkspace`),
    });
  });
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- persisted replay JSON enters here.
export function parseReplaySession(value: unknown): Result<ReplaySession, ReplaySchemaError> {
  const json = parseJsonValue(value);
  if (Result.isError(json)) {
    return schemaError("$", "must be a JSON value");
  }
  return Result.gen(function* () {
    const record = yield* readRecord(json.value, "$");
    const version = record.schemaVersion;
    if (version === undefined) {
      return schemaError("$.schemaVersion", "is required");
    }
    if (version !== REPLAY_SCHEMA_VERSION) {
      return schemaError("$.schemaVersion", `unsupported version ${JSON.stringify(version)}`);
    }

    const seed = yield* readInteger(record.seed, "$.seed");
    if (seed < 0 || seed > 0xffff_ffff) {
      return schemaError("$.seed", "must be an unsigned 32-bit integer");
    }

    const clockRecord = yield* readRecord(record.clock, "$.clock");
    const turnValues = yield* readArray(record.turns, "$.turns");
    const turns: ReplayTurn[] = [];
    for (let index = 0; index < turnValues.length; index += 1) {
      turns.push(yield* parseTurn(turnValues[index], `$.turns[${index}]`));
    }

    return Result.ok<ReplaySession>({
      schemaVersion: REPLAY_SCHEMA_VERSION,
      name: yield* readNonEmptyString(record.name, "$.name"),
      seed,
      clock: {
        nowMs: yield* readFiniteNumber(clockRecord.nowMs, "$.clock.nowMs"),
      },
      initialWorkspace: yield* parseWorkspaceTree(record.initialWorkspace, "$.initialWorkspace"),
      turns,
      expectedEffects: yield* parseObservableEffects(record.expectedEffects, "$.expectedEffects"),
    });
  });
}

export function parseReplaySessionJson(json: string): Result<ReplaySession, ReplaySchemaError> {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return schemaError("$", `invalid JSON: ${detail}`);
  }
  return parseReplaySession(value);
}

export { REPLAY_SCHEMA_VERSION, ReplaySchemaError } from "./schema.js";
