import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { expect, test } from "vitest";
import { AddressedPathText } from "../../../src/workspace/project/resolve.js";
import {
  OperationIdText,
  StartExecInput,
  WriteFileInput,
} from "../../../src/workspace/project/start-exec-input.js";

const WRITE_PATH = "/f.txt";

test.each([null, 123, undefined, {}])("a path that is not a string is refused: %j", (path) => {
  expect(Result.isFailure(Schema.decodeUnknownResult(AddressedPathText)(path))).toBe(true);
});

test.each([null, 123, undefined])("an operation id that is not a string is refused: %j", (id) => {
  expect(Result.isFailure(Schema.decodeUnknownResult(OperationIdText)(id))).toBe(true);
});

test.each<readonly [string, unknown]>([
  ["bytes that are a string", { path: WRITE_PATH, bytes: "not bytes", mode: "overwrite" }],
  ["an unknown mode", { path: WRITE_PATH, bytes: new Uint8Array(), mode: "bogus-mode" }],
  ["a null mode", { path: WRITE_PATH, bytes: new Uint8Array(), mode: null }],
  ["a missing mode", { path: WRITE_PATH, bytes: new Uint8Array() }],
])("a write with %s is refused", (_label, input) => {
  expect(Result.isFailure(Schema.decodeUnknownResult(WriteFileInput)(input))).toBe(true);
});

test.each<readonly [string, unknown]>([
  ["null", null],
  ["a missing command", {}],
  ["a non-string command", { command: 5 }],
  ["a string timeout", { command: "true", timeoutMs: "10" }],
  ["a null cwd", { command: "true", cwd: null }],
])("an exec request that is %s is refused", (_label, input) => {
  expect(Result.isFailure(Schema.decodeUnknownResult(StartExecInput)(input))).toBe(true);
});
