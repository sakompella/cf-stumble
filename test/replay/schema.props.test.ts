import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { expect, test } from "vitest";

import { isJsonValue } from "../../src/json.js";
import {
  parseReplaySession,
  parseReplaySessionJson,
  REPLAY_SCHEMA_VERSION,
} from "../../src/replay/schema-parser.js";
import { arbitraryJson, replaySessionJson } from "../support/json-generators.js";
import { expectErr, expectOk } from "../support/result.js";

/**
 * A property layer over `test/replay/schema.test.ts`, which parses one good recording and four
 * specific bad ones. Replay tapes are persisted, then read back and fed to the validation gate, so
 * this parser is the boundary ADR-0016 says has to narrow untrusted input by hand — and a
 * hand-written narrowing is exactly the kind that is total on the inputs its author imagined.
 */

test("parsing arbitrary JSON is total: a session, or a ReplaySchemaError, and nothing else", () => {
  hegel.test((tc) => {
    const parsed = parseReplaySession(tc.draw(arbitraryJson));

    if (parsed.isErr()) {
      expect(parsed.error).toMatchObject({ _tag: "ReplaySchemaError" });
      expect(parsed.error.path).not.toBe("");
      return;
    }
    expect(parsed.value.schemaVersion).toBe(REPLAY_SCHEMA_VERSION);
  });
});

/**
 * Unlike its neighbours this is not a property: it asserts that `arbitraryJson` is diverse enough
 * for the totality property above to mean anything. A generator that produced only junk would be
 * rejected at `$.schemaVersion` every time, and totality would prove one `if` statement.
 *
 * That makes it a claim about counts over a draw sequence, so it needs a fixed seed. Hegel only
 * derandomizes in CI, which left this failing roughly one local run in ten and made the
 * pre-commit gate unreliable. The counts still move if the generator regresses; they just no
 * longer move on their own.
 */
test("generated JSON reaches past the version check, so totality is not one `if`", () => {
  let accepted = 0;
  const rejectedAt = new Set<string>();

  hegel.test(
    (tc) => {
      const parsed = parseReplaySession(tc.draw(arbitraryJson));
      if (parsed.isErr()) {
        rejectedAt.add(parsed.error.path);
      } else {
        accepted += 1;
      }
    },
    { testCases: 500, seed: 1, derandomize: true },
  );

  expect(accepted).toBeGreaterThan(0);
  // A generator that only ever produced junk would report `$.schemaVersion` and nothing else.
  const deep = [...rejectedAt].filter((path) => path.split(".").length > 2);
  expect(deep.length).toBeGreaterThan(3);
});

test("parsing an arbitrary string is total, malformed JSON included", () => {
  hegel.test((tc) => {
    const text = tc.draw(
      gs.oneOf(
        gs.text({ maxSize: 60 }),
        arbitraryJson.map((value) => JSON.stringify(value) ?? "null"),
      ),
    );

    const parsed = parseReplaySessionJson(text);
    if (parsed.isErr()) {
      expect(parsed.error).toMatchObject({ _tag: "ReplaySchemaError" });
    }
  });
});

test("a recorded session survives a trip through JSON", () => {
  hegel.test((tc) => {
    const session = tc.draw(replaySessionJson);
    const parsed = expectOk(parseReplaySessionJson(JSON.stringify(session)));

    // The parser sorts workspace trees by path, so compare against its own output on a second
    // pass rather than against the input: the claim is that parsing settles, not that it is
    // the identity.
    expect(expectOk(parseReplaySessionJson(JSON.stringify(parsed)))).toEqual(parsed);
  });
});

test("dropping any required field is rejected rather than defaulted", () => {
  hegel.test((tc) => {
    const session = tc.draw(replaySessionJson);
    const key = tc.draw(
      gs.sampledFrom([
        "schemaVersion",
        "name",
        "seed",
        "clock",
        "initialWorkspace",
        "turns",
        "expectedEffects",
      ] as const),
    );
    const { [key]: _dropped, ...withoutKey } = session;

    // A parser that fills in a default here would let a tape recorded under one schema be
    // replayed as though it were another, which is the failure ADR-0005's ratchet cannot see.
    expect(expectErr(parseReplaySession(withoutKey))).toMatchObject({
      _tag: "ReplaySchemaError",
    });
  });
});

test("the JSON guard accepts exactly what JSON.stringify can round-trip", () => {
  hegel.test((tc) => {
    const value = tc.draw(arbitraryJson);

    // `isJsonValue` is the gate every boundary parser in the repo sits behind, so what it accepts
    // has to be what `JSON.parse` can hand back unchanged.
    expect(isJsonValue(value)).toBe(true);
    const reparsed: unknown = JSON.parse(JSON.stringify(value));
    // Narrow through the real predicate rather than assert: the claim is that `JSON.parse` hands
    // back a `JsonValue`, and a cast here would only assume the very thing being tested.
    if (!isJsonValue(reparsed)) {
      throw new Error("JSON.parse produced a value the JSON guard does not accept");
    }
    expect(reparsed).toEqual(value);
  });
});

test("the JSON guard rejects values JSON cannot carry", () => {
  hegel.test((tc) => {
    const unsupportedKind = tc.draw(
      gs.sampledFrom(["undefined", "bigint", "function", "symbol", "nan", "infinity"] as const),
    );
    const notJson: unknown = {
      undefined: undefined,
      bigint: 1n,
      function: () => {},
      symbol: Symbol("s"),
      nan: Number.NaN,
      infinity: Number.POSITIVE_INFINITY,
    }[unsupportedKind];

    expect(isJsonValue(notJson)).toBe(false);
    expect(isJsonValue([tc.draw(arbitraryJson), notJson])).toBe(false);
  });
});
