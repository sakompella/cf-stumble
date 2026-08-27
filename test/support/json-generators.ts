import type { TestCase } from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";

import { isJsonObjectValue, type JsonObject, type JsonValue } from "../../src/json.js";
import { REPLAY_SCHEMA_VERSION } from "../../src/replay/schema.js";

/**
 * Generators for the JSON boundary in `src/json.ts` and `src/replay/schema-parser.ts`.
 *
 * The parser gives up at `$.schemaVersion` on almost any random object, so a totality property fed
 * only random JSON would be testing one `if`. `arbitraryJson` therefore mixes free-form JSON with
 * well-formed recordings and with recordings corrupted at one randomly chosen position, which is
 * what carries a case deep enough to reach the primitive-call and workspace-tree parsers.
 */

const jsonPrimitives = gs.oneOf<JsonValue>(
  gs.just(null),
  gs.booleans(),
  gs.integers({ minValue: -1000, maxValue: 1000 }),
  // JSON has no way to write NaN or an infinity, and `-0` comes back as `0`, so neither can
  // survive a round trip and neither belongs in a generator of round-trippable values.
  gs
    .floats({ allowNan: false, allowInfinity: false })
    .map((value) => (Object.is(value, -0) ? 0 : value)),
  gs.text({ maxSize: 12 }),
  // The parser branches on these, so drawing them as data is what makes a corrupted recording
  // land on a plausible-but-wrong value rather than on an obviously wrong one.
  gs.sampledFrom(["read", "write", "edit", "bash", "", "0"]),
);

function freeJson(tc: TestCase, depth: number): JsonValue {
  if (depth === 0 || tc.draw(gs.booleans())) {
    return tc.draw(jsonPrimitives);
  }
  if (tc.draw(gs.booleans())) {
    const size = tc.draw(gs.integers({ minValue: 0, maxValue: 4 }));
    return Array.from({ length: size }, () => freeJson(tc, depth - 1));
  }
  const keys = tc.draw(
    gs.arrays(gs.sampledFrom(["kind", "path", "content", "seed", "turns", "x"]), {
      maxSize: 4,
      unique: true,
    }),
  );
  return Object.fromEntries(keys.map((key) => [key, freeJson(tc, depth - 1)]));
}

/** The parser rejects a tree holding one path twice, so the paths are made distinct by hand. */
const workspaceTrees = gs.composite<readonly JsonObject[]>((tc) => {
  const paths = tc.draw(
    gs.arrays(gs.sampledFrom(["README.md", "src/app.ts", "a", "内容.txt", "b/c/d.txt"]), {
      maxSize: 3,
    }),
  );
  return [...new Set(paths)].map((path) => ({ path, content: tc.draw(gs.text({ maxSize: 12 })) }));
});

const primitiveCalls = gs.composite<JsonObject>((tc) => {
  const path = tc.draw(gs.sampledFrom(["README.md", "src/app.ts", "a"]));
  const kind = tc.draw(gs.sampledFrom(["read", "write", "edit", "bash"] as const));
  switch (kind) {
    case "read":
      return { kind: "read", path };
    case "write":
      return { kind: "write", path, content: tc.draw(gs.text({ maxSize: 12 })) };
    case "edit":
      return {
        kind: "edit",
        path,
        oldText: tc.draw(gs.text({ maxSize: 8 })),
        newText: tc.draw(gs.text({ maxSize: 8 })),
      };
    case "bash":
      return { kind: "bash", command: tc.draw(gs.text({ minSize: 1, maxSize: 12 })) };
    default:
      kind satisfies never;
      throw new Error("unreachable primitive call kind");
  }
});

// `call.kind` carries the full `JsonValue | undefined` the index signature allows, not the
// four-way literal union it is actually drawn from, so this reads as `if`/`else` rather than a
// `switch`: a `switch` here would force every other literal `JsonValue` member (`null`,
// `undefined`, `true`, `false`) into its own case just to fall through to the same default as any
// non-"write"/"edit"/"bash" string, number, array, or object already does.
const capturedToolResults = gs.composite<JsonObject>((tc) => {
  const call = tc.draw(primitiveCalls);
  const integers = gs.integers({ minValue: 0, maxValue: 255 });
  if (call.kind === "write") {
    return { call, result: { kind: "write", bytesWritten: tc.draw(integers) } };
  }
  if (call.kind === "edit") {
    return { call, result: { kind: "edit", replacements: tc.draw(integers) } };
  }
  if (call.kind === "bash") {
    return {
      call,
      result: {
        kind: "bash",
        exitCode: tc.draw(integers),
        stdout: tc.draw(gs.text({ maxSize: 8 })),
        stderr: tc.draw(gs.text({ maxSize: 8 })),
      },
      // Only a bash result carries one, and the parser rejects it anywhere else.
      workspaceAfter: tc.draw(workspaceTrees),
    };
  }
  return { call, result: { kind: "read", content: tc.draw(gs.text({ maxSize: 8 })) } };
});

const turns = gs.composite<JsonObject>((tc) => ({
  input: tc.draw(gs.text({ maxSize: 12 })),
  modelResponses: tc.draw(
    gs.arrays(
      gs.composite<JsonObject>((inner) => ({
        requestId: inner.draw(gs.sampledFrom(["executor", "planner"])),
        content: inner.draw(gs.text({ maxSize: 12 })),
      })),
      { maxSize: 2 },
    ),
  ),
  capturedToolResults: tc.draw(gs.arrays(capturedToolResults, { maxSize: 2 })),
}));

/** A recording the parser accepts, as the JSON object it would have been persisted as. */
export const replaySessionJson = gs.composite<JsonObject>((tc) => ({
  schemaVersion: REPLAY_SCHEMA_VERSION,
  name: tc.draw(gs.text({ minSize: 1, maxSize: 12 })),
  seed: tc.draw(gs.integers({ minValue: 0, maxValue: 0xffff_ffff })),
  clock: { nowMs: tc.draw(gs.integers({ minValue: 0, maxValue: 2 ** 42 })) },
  initialWorkspace: tc.draw(workspaceTrees),
  turns: tc.draw(gs.arrays(turns, { maxSize: 2 })),
  expectedEffects: {
    trace: tc.draw(gs.arrays(primitiveCalls, { maxSize: 2 })),
    finalWorkspace: tc.draw(workspaceTrees),
  },
}));

/**
 * `Array.isArray` narrows a union to `any[]` rather than to the one array shape `JsonValue`
 * allows, which is what let an `any` escape the recursive call below. A type predicate stated
 * against `JsonValue` itself keeps the narrowing exact, the same way `isJsonObjectValue` does for
 * the object case (ADR-0015).
 */
function isJsonArrayValue(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}

/** Replace one value somewhere inside `value`, descending at random until it runs out of container. */
function corruptSomewhere(tc: TestCase, value: JsonValue): JsonValue {
  if (isJsonArrayValue(value) && value.length > 0 && tc.draw(gs.booleans())) {
    const at = tc.draw(gs.integers({ minValue: 0, maxValue: value.length - 1 }));
    return value.map((child, index) => (index === at ? corruptSomewhere(tc, child) : child));
  }
  if (isJsonObjectValue(value)) {
    const keys = Object.keys(value);
    if (keys.length > 0 && tc.draw(gs.booleans())) {
      const key = tc.draw(gs.sampledFrom(keys));
      const child = value[key];
      if (child !== undefined) {
        return { ...value, [key]: corruptSomewhere(tc, child) };
      }
    }
  }
  return tc.draw(jsonPrimitives);
}

export const arbitraryJson = gs.composite<JsonValue>((tc) => {
  const source = tc.draw(gs.sampledFrom(["free", "valid", "corrupted"] as const));
  switch (source) {
    case "free":
      return freeJson(tc, tc.draw(gs.integers({ minValue: 0, maxValue: 4 })));
    case "valid":
      return tc.draw(replaySessionJson);
    case "corrupted":
      return corruptSomewhere(tc, tc.draw(replaySessionJson));
    default:
      source satisfies never;
      throw new Error("unreachable JSON source");
  }
});
