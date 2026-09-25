// oxlint-disable anti-slop/no-known-value-widening, max-lines-per-function, anti-slop/require-readable-spacing, anti-slop/no-runtime-typeof -- Generated frames intentionally use a local wire-shape oracle.
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { expect, test } from "vitest";

import { parseFacetFrameLine } from "../../../src/supervisor/projects/turn-frames.js";

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { readonly [key: string]: JsonValue };
type JsonObject = { readonly [key: string]: JsonValue };

type FrameKind =
  | "text"
  | "tool-start"
  | "tool-result"
  | "diff"
  | "diff-unavailable"
  | "completed"
  | "failed"
  | "rejected";

const kinds = gs.sampledFrom([
  "text",
  "tool-start",
  "tool-result",
  "diff",
  "diff-unavailable",
  "completed",
  "failed",
  "rejected",
] as const);

const shortText = gs.text({ alphabet: "abc XYZ012-é", maxSize: 12 });
const code = gs.sampledFrom(["model-call-limit", "model-error"] as const);
const rejectedCode = gs.sampledFrom([
  "invalid-project-capability",
  "invalid-turn-request",
] as const);

function drawJson(tc: hegel.TestCase, depth = 0): JsonValue {
  if (depth >= 2) {
    return tc.draw(gs.sampledFrom([null, false, true, 0, 1, "value"] as const));
  }

  switch (
    tc.draw(gs.sampledFrom(["null", "boolean", "number", "string", "array", "object"] as const))
  ) {
    case "null":
      return null;
    case "boolean":
      return tc.draw(gs.booleans());
    case "number":
      return tc.draw(gs.integers({ minValue: -1000, maxValue: 1000 }));
    case "string":
      return tc.draw(shortText);
    case "array": {
      const values = tc.draw(
        gs.arrays(gs.integers({ minValue: -100, maxValue: 100 }), { maxSize: 3 }),
      );

      return values.map((value) => (value % 2 === 0 ? value : drawJson(tc, depth + 1)));
    }
    case "object": {
      const count = tc.draw(gs.integers({ minValue: 0, maxValue: 3 }));
      const result: Record<string, JsonValue> = {};

      for (let index = 0; index < count; index += 1) {
        result[`field${index}`] = drawJson(tc, depth + 1);
      }

      return result;
    }
  }

  return null;
}

function drawObject(tc: hegel.TestCase): JsonObject {
  const value = drawJson(tc);

  if (typeof value === "object" && value !== null && !Array.isArray(value)) return value;

  return { value };
}

function drawFrame(tc: hegel.TestCase): { kind: FrameKind; frame: JsonObject } {
  const kind = tc.draw(kinds);

  switch (kind) {
    case "text":
      return { kind, frame: { kind, text: tc.draw(shortText) } };
    case "tool-start":
      return {
        kind,
        frame: {
          kind,
          toolCallId: tc.draw(shortText),
          toolName: tc.draw(shortText),
          arguments: drawObject(tc),
        },
      };
    case "tool-result":
      return {
        kind,
        frame: {
          kind,
          toolCallId: tc.draw(shortText),
          toolName: tc.draw(shortText),
          isError: tc.draw(gs.booleans()),
          content: tc.draw(shortText),
          truncated: tc.draw(gs.booleans()),
        },
      };
    case "diff":
      return {
        kind,
        frame: { kind, content: tc.draw(shortText), truncated: tc.draw(gs.booleans()) },
      };
    case "diff-unavailable":
      return { kind, frame: { kind, detail: tc.draw(shortText) } };
    case "completed":
      return {
        kind,
        frame: { kind, state: { messages: tc.draw(gs.arrays(gs.integers(), { maxSize: 3 })) } },
      };
    case "failed":
      return {
        kind,
        frame: {
          kind,
          code: tc.draw(code),
          state: { messages: tc.draw(gs.arrays(gs.integers(), { maxSize: 3 })) },
        },
      };
    case "rejected":
      return { kind, frame: { kind, code: tc.draw(rejectedCode) } };
  }

  throw new Error("unknown frame kind");
}

const declaredKeys: Readonly<Record<FrameKind, readonly string[]>> = {
  text: ["kind", "text"],
  "tool-start": ["arguments", "kind", "toolCallId", "toolName"],
  "tool-result": ["content", "isError", "kind", "toolCallId", "toolName", "truncated"],
  diff: ["content", "kind", "truncated"],
  "diff-unavailable": ["detail", "kind"],
  completed: ["kind", "messages"],
  failed: ["code", "kind", "messages"],
  rejected: ["code", "kind"],
};

test("parsing drops arbitrary extra frame fields and forwards exactly the declared fields", () => {
  hegel.test((tc) => {
    const { kind, frame } = drawFrame(tc);
    const extraKey = `extra_${tc.draw(gs.text({ alphabet: "abc012", maxSize: 8 }))}`;
    const withExtra = { ...frame, [extraKey]: drawJson(tc) };
    const parsed = parseFacetFrameLine(JSON.stringify(frame));
    const parsedWithExtra = parseFacetFrameLine(JSON.stringify(withExtra));

    expect(parsedWithExtra).toEqual(parsed);

    if (parsed.kind === "forwarded") {
      expect(Object.keys(parsed.frame).toSorted()).toEqual(declaredKeys[kind]);
    }
  });
});

test("dropping any declared frame field makes the frame malformed", () => {
  hegel.test((tc) => {
    const { kind, frame } = drawFrame(tc);
    const required = Object.keys(frame).filter(
      (field) => !(kind === "tool-start" && field === "arguments"),
    );
    const missing = tc.draw(gs.sampledFrom(required));
    const incomplete = { ...frame };
    delete incomplete[missing];

    expect(parseFacetFrameLine(JSON.stringify(incomplete))).toEqual({
      kind: "invalid",
      problem: "malformed-frame",
    });
  });
});

test("parsing arbitrary lines never throws", () => {
  hegel.test((tc) => {
    expect(() => parseFacetFrameLine(tc.draw(gs.text()))).not.toThrow();
  });
});
