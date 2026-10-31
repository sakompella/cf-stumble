import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { AddressedPathText, decodeAddressedPathText, segmentsOfAddressedPath } from "./resolve.js";
import {
  fail,
  MAX_EXEC_COMMAND_BYTES,
  MAX_EXEC_TIMEOUT_MS,
  ok,
  type ProjectResult,
  type StartExecWire,
  type WriteFileWire,
} from "./protocol.js";

const OPERATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9]+$/u;

function isBytes(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array;
}

const WriteModeText = Schema.Literals(["overwrite", "append", "create-exclusive"]);

export const WriteFileInput = Schema.Struct({
  path: AddressedPathText,
  bytes: Schema.declare(isBytes),
  mode: WriteModeText,
});

const decodeWriteFileInput = Schema.decodeResult(WriteFileInput);

export function parseWriteFileInput(input: WriteFileWire): ProjectResult<WriteFileWire> {
  const decoded = decodeWriteFileInput(input);

  return Result.isFailure(decoded) ? fail("invalid-request") : ok(decoded.success);
}

export const OperationIdText = Schema.String.check(Schema.isPattern(OPERATION_ID_PATTERN));

const decodeOperationId = Schema.decodeResult(OperationIdText);

export function parseOperationId(operationId: string): ProjectResult<string> {
  const decoded = decodeOperationId(operationId);

  return Result.isFailure(decoded) ? fail("invalid-request") : ok(decoded.success);
}

const CommandText = Schema.String.check(
  Schema.isMinLength(1),
  Schema.makeFilter<string>(
    (command) => new TextEncoder().encode(command).byteLength <= MAX_EXEC_COMMAND_BYTES,
  ),
);

export const StartExecInput = Schema.Struct({
  command: CommandText,
  cwd: Schema.optional(Schema.String),
  timeoutMs: Schema.optional(Schema.Finite.check(Schema.isGreaterThan(0))),
});

const decodeStartExecInput = Schema.decodeResult(StartExecInput, { onExcessProperty: "error" });

export interface ParsedStartExecInput {
  command: string;
  cwdSegments: readonly string[];
  timeoutMs: number;
}

export function parseStartExecInput(input: StartExecWire): ProjectResult<ParsedStartExecInput> {
  const decoded = decodeStartExecInput(input);

  if (Result.isFailure(decoded)) return fail("invalid-request");

  const cwd = decodeAddressedPathText(decoded.success.cwd ?? "/");

  if (Result.isFailure(cwd)) return fail("invalid-request");

  return ok({
    command: decoded.success.command,
    cwdSegments: segmentsOfAddressedPath(cwd.success),
    timeoutMs: Math.min(decoded.success.timeoutMs ?? MAX_EXEC_TIMEOUT_MS, MAX_EXEC_TIMEOUT_MS),
  });
}
