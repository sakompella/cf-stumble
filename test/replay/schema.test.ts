import { expect, test } from "vitest";
import { parseJsonValue } from "../../src/json.js";
import {
  REPLAY_SCHEMA_VERSION,
  parseReplaySession,
  parseReplaySessionJson,
} from "../../src/replay/schema-parser.js";
import { expectErr, expectOk } from "../support/result.js";

const validRecording = {
  schemaVersion: REPLAY_SCHEMA_VERSION,
  name: "schema-example",
  seed: 7,
  clock: { nowMs: 1_700_000_000_000 },
  initialWorkspace: [{ path: "README.md", content: "before\n" }],
  turns: [
    {
      input: "make the change",
      modelResponses: [{ requestId: "executor", content: "done" }],
      capturedToolResults: [],
    },
  ],
  expectedEffects: {
    trace: [],
    finalWorkspace: [{ path: "README.md", content: "before\n" }],
  },
} as const;

test("rejects non-JSON input with a tagged result", () => {
  expect(expectErr(parseJsonValue(Number.NaN))).toMatchObject({
    _tag: "NotJsonValueError",
    message: "value is not a JSON value",
  });
});

test("parses a versioned replay recording into pinned values", () => {
  const recording = expectOk(parseReplaySession(validRecording));

  expect(recording.schemaVersion).toBe(1);
  expect(recording.name).toBe("schema-example");
  expect(recording.seed).toBe(7);
  expect(recording.clock.nowMs).toBe(1_700_000_000_000);
  expect(recording.initialWorkspace).toEqual([{ path: "README.md", content: "before\n" }]);
  expect(recording.turns[0]?.modelResponses[0]?.content).toBe("done");
});

test("rejects a missing schema version instead of guessing", () => {
  const { schemaVersion: _schemaVersion, ...withoutVersion } = validRecording;

  expect(expectErr(parseReplaySession(withoutVersion))).toMatchObject({
    _tag: "ReplaySchemaError",
    path: "$.schemaVersion",
    condition: "is required",
  });
});

test("rejects an unknown schema version instead of defaulting", () => {
  expect(expectErr(parseReplaySession({ ...validRecording, schemaVersion: 99 }))).toMatchObject({
    _tag: "ReplaySchemaError",
    path: "$.schemaVersion",
    condition: "unsupported version 99",
  });
});

test("reports malformed JSON with a diagnosable path", () => {
  const error = expectErr(parseReplaySessionJson('{"schemaVersion":'));

  expect(error).toMatchObject({ _tag: "ReplaySchemaError", path: "$" });
  expect(error.message).toMatch(/replay schema error at \$: invalid JSON/u);
});

test("reports the path of malformed recording data", () => {
  expect(
    expectErr(
      parseReplaySession({
        ...validRecording,
        turns: [{ ...validRecording.turns[0], modelResponses: [{ content: 42 }] }],
      }),
    ),
  ).toMatchObject({ path: "$.turns[0].modelResponses[0].requestId" });
});
