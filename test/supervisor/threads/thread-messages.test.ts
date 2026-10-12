import { expect, test } from "vitest";
import * as Result from "effect/Result";
import type { AgentMessage } from "@cf-stumble/pi";
import {
  parseThreadMessages,
  serializeThreadMessages,
  THREAD_MESSAGE_FIELDS,
} from "../../../src/supervisor/threads/index.js";
import { THREAD_MESSAGE_SAMPLE_LIST, THREAD_MESSAGE_SAMPLES } from "./message-samples.js";

function roundTrip(messages: readonly AgentMessage[]): readonly AgentMessage[] {
  const parsed = parseThreadMessages(serializeThreadMessages(messages));

  if (Result.isFailure(parsed)) {
    throw new Error(`the stored thread must read back: ${parsed.failure.reason}`);
  }

  return parsed.success;
}

function fieldsOf(message: AgentMessage): ReadonlyMap<string, unknown> {
  return new Map(Object.entries(message));
}

test("every AgentMessage variant survives a write and a read with all of its fields", () => {
  for (const [role, sample] of Object.entries(THREAD_MESSAGE_SAMPLES)) {
    const [restored] = roundTrip([sample]);

    if (restored === undefined) {
      throw new Error(`the ${role} message did not come back at all`);
    }

    expect(restored, `the ${role} message must come back unchanged`).toEqual(sample);
    expect(
      [...fieldsOf(restored).keys()].toSorted(),
      `the ${role} message must come back with the same fields`,
    ).toEqual([...fieldsOf(sample).keys()].toSorted());
  }
});

/**
 * The round-trip above compares with `toEqual`, which treats a property that is `undefined` on
 * both sides as equal. A sample that left a field unset would therefore pass even if the codec
 * dropped that field, so this holds the samples to the field list the codec is written from.
 */
test("every sample populates every field its variant declares", () => {
  for (const [role, fields] of Object.entries(THREAD_MESSAGE_FIELDS)) {
    const sample = Object.entries(THREAD_MESSAGE_SAMPLES).find(([key]) => key === role)?.[1];

    if (sample === undefined) {
      throw new Error(`no sample exists for the ${role} message`);
    }

    for (const field of Object.keys(fields)) {
      expect(fieldsOf(sample).get(field), `the ${role} sample leaves ${field} unset`).toBeDefined();
    }
  }
});

test("a whole thread keeps its message order", () => {
  const thread = [...THREAD_MESSAGE_SAMPLE_LIST, ...THREAD_MESSAGE_SAMPLE_LIST];

  expect(roundTrip(thread)).toEqual(thread);
});

test("an empty or absent thread reads back as an empty conversation", () => {
  const empty = parseThreadMessages("");
  const absent = parseThreadMessages(null);
  const written = parseThreadMessages(serializeThreadMessages([]));

  expect(Result.isSuccess(empty) && empty.success).toEqual([]);
  expect(Result.isSuccess(absent) && absent.success).toEqual([]);
  expect(Result.isSuccess(written) && written.success).toEqual([]);
});

test("a stored entry with an unknown role is unreadable rather than an untyped message", () => {
  const parsed = parseThreadMessages(JSON.stringify([{ role: "telepathy", timestamp: 1 }]));

  expect(Result.isFailure(parsed)).toBe(true);
  expect(Result.isFailure(parsed) && parsed.failure.reason).toContain("telepathy");
});

test("a stored entry missing a required field is unreadable", () => {
  const parsed = parseThreadMessages(
    JSON.stringify([{ role: "compactionSummary", summary: "s", timestamp: 1 }]),
  );

  expect(Result.isFailure(parsed)).toBe(true);
  expect(Result.isFailure(parsed) && parsed.failure.reason).toContain("tokensBefore");
});

test("a stored entry whose field is the wrong kind is unreadable", () => {
  const parsed = parseThreadMessages(
    JSON.stringify([{ role: "branchSummary", summary: 7, fromId: "b", timestamp: 1 }]),
  );

  expect(Result.isFailure(parsed)).toBe(true);
  expect(Result.isFailure(parsed) && parsed.failure.reason).toContain("summary");
});

test("a stored entry carrying a field no variant declares is unreadable", () => {
  const parsed = parseThreadMessages(
    JSON.stringify([
      { role: "branchSummary", summary: "s", fromId: "b", timestamp: 1, injected: "extra" },
    ]),
  );

  expect(Result.isFailure(parsed)).toBe(true);
  expect(Result.isFailure(parsed) && parsed.failure.reason).toContain("injected");
});

test("a column that is not a list of JSON objects is unreadable", () => {
  expect(Result.isFailure(parseThreadMessages("{"))).toBe(true);
  expect(Result.isFailure(parseThreadMessages('{"role":"user"}'))).toBe(true);
  expect(Result.isFailure(parseThreadMessages("[7]"))).toBe(true);
});
