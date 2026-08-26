import { expect, test } from "vitest";
import {
  REPLAY_SCHEMA_VERSION,
  ReplaySchemaError,
  parseReplaySession,
  parseReplaySessionJson,
} from "../../src/replay/schema-parser.js";

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

test("parses a versioned replay recording into pinned values", () => {
  const recording = parseReplaySession(validRecording);

  expect(recording.schemaVersion).toBe(1);
  expect(recording.name).toBe("schema-example");
  expect(recording.seed).toBe(7);
  expect(recording.clock.nowMs).toBe(1_700_000_000_000);
  expect(recording.initialWorkspace).toEqual([
    { path: "README.md", content: "before\n" },
  ]);
  expect(recording.turns[0]?.modelResponses[0]?.content).toBe("done");
});

test("rejects a missing schema version instead of guessing", () => {
  const { schemaVersion: _schemaVersion, ...withoutVersion } = validRecording;

  expect(() => parseReplaySession(withoutVersion)).toThrow(
    new ReplaySchemaError("$.schemaVersion", "is required"),
  );
});

test("rejects an unknown schema version instead of defaulting", () => {
  expect(() =>
    parseReplaySession({ ...validRecording, schemaVersion: 99 }),
  ).toThrow(
    new ReplaySchemaError("$.schemaVersion", "unsupported version 99"),
  );
});

test("reports malformed JSON with a diagnosable path", () => {
  expect(() => parseReplaySessionJson('{"schemaVersion":')).toThrow(
    /replay schema error at \$: invalid JSON/u,
  );
});

test("reports the path of malformed recording data", () => {
  expect(() =>
    parseReplaySession({
      ...validRecording,
      turns: [{ ...validRecording.turns[0], modelResponses: [{ content: 42 }] }],
    }),
  ).toThrow(/\$\.turns\[0\]\.modelResponses\[0\]\.requestId/u);
});
