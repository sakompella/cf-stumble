import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import * as Result from "effect/Result";
import { expect, test } from "vitest";
import {
  MAX_EXEC_COMMAND_BYTES,
  MAX_EXEC_TIMEOUT_MS,
  type StartExecWire,
} from "../../../src/workspace/project/protocol.js";
import {
  parseOperationId,
  parseStartExecInput,
  parseWriteFileInput,
} from "../../../src/workspace/project/start-exec-input.js";

type Drawn<T> = readonly [value: T, valid: boolean];

type DrawnPath = readonly [path: string, segments: readonly string[] | undefined];

const segment = gs
  .text({ alphabet: "ab.-_é ", minSize: 1, maxSize: 3 })
  .filter((text) => text !== "." && text !== "..");

const BROKEN_PATHS = [
  "",
  "a",
  "a/b",
  "/a/",
  "/a//b",
  "/a/./b",
  "/a/../b",
  "/..",
  "/a\\b",
  "/a\u0000b",
];

function drawPath(tc: hegel.TestCase): DrawnPath {
  if (tc.draw(gs.integers({ minValue: 0, maxValue: 3 })) === 0) {
    return [tc.draw(gs.sampledFrom(BROKEN_PATHS)), undefined];
  }

  const segments = tc.draw(gs.arrays(segment, { maxSize: 3 }));

  return [`/${segments.join("/")}`, segments];
}

function drawCommand(tc: hegel.TestCase): Drawn<string> {
  if (tc.draw(gs.booleans())) {
    const command = tc.draw(gs.text({ maxSize: 6 }));

    return [command, command !== ""];
  }

  const bytes = MAX_EXEC_COMMAND_BYTES + tc.draw(gs.integers({ minValue: -4, maxValue: 4 }));
  const emoji = tc.draw(gs.integers({ minValue: 0, maxValue: 8 }));
  const accents = tc.draw(gs.integers({ minValue: 0, maxValue: 8 }));

  const command = `${"😀".repeat(emoji)}${"é".repeat(accents)}`.padEnd(
    bytes - emoji * 2 - accents,
    "a",
  );

  return [command, bytes <= MAX_EXEC_COMMAND_BYTES];
}

const BROKEN_TIMEOUTS = [
  0,
  -0,
  -5,
  -0.5,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
];

function drawTimeout(tc: hegel.TestCase): Drawn<number | undefined> {
  const kind = tc.draw(gs.sampledFrom(["absent", "broken", "valid"] as const));

  if (kind === "absent") return [undefined, true];

  if (kind === "broken") return [tc.draw(gs.sampledFrom(BROKEN_TIMEOUTS)), false];

  const timeout = tc.draw(
    gs.oneOf(
      gs.integers({ minValue: 1, maxValue: 2 * MAX_EXEC_TIMEOUT_MS }),
      gs.sampledFrom([Number.MIN_VALUE, 0.5, MAX_EXEC_TIMEOUT_MS, MAX_EXEC_TIMEOUT_MS + 1]),
    ),
  );

  return [timeout, true];
}

test("startExec input parses exactly when every field is valid, with the timeout capped", () => {
  hegel.test(
    (tc) => {
      const [command, commandValid] = drawCommand(tc);
      const [cwd, cwdSegments] = tc.draw(gs.booleans()) ? drawPath(tc) : [undefined, []];
      const [timeoutMs, timeoutValid] = drawTimeout(tc);
      const backend = tc.draw(gs.sampledFrom([undefined, "isolate", "container"] as const));
      const extra = tc.draw(gs.sampledFrom([{}, { extra: true }, { cwdSegments: [] }]));

      const input: StartExecWire = { ...extra, command, cwd, timeoutMs, backend };

      const valid =
        commandValid &&
        cwdSegments !== undefined &&
        timeoutValid &&
        Object.keys(extra).length === 0;

      const expected = {
        command,
        cwdSegments,
        timeoutMs: Math.min(timeoutMs ?? MAX_EXEC_TIMEOUT_MS, MAX_EXEC_TIMEOUT_MS),
        backend,
      };

      expect(parseStartExecInput(input)).toEqual(
        valid ? { ok: true, value: expected } : { ok: false, error: { code: "invalid-request" } },
      );
    },
    { testCases: 300 },
  );
});

test("a write parses with any write mode exactly when its path is canonical", () => {
  hegel.test(
    (tc) => {
      const [path, segments] = drawPath(tc);

      const bytes = new Uint8Array(
        tc.draw(gs.arrays(gs.integers({ minValue: 0, maxValue: 255 }), { maxSize: 4 })),
      );

      const mode = tc.draw(gs.sampledFrom(["overwrite", "append", "create-exclusive"] as const));

      const parsed = parseWriteFileInput({ path, bytes, mode });

      expect(Result.isSuccess(parsed) ? parsed.success : parsed.failure).toEqual(
        segments === undefined ? { code: "invalid-request" } : { path, bytes, mode },
      );
    },
    { testCases: 100 },
  );
});

const HEX_GROUPS = [8, 4, 4, 4, 12];

test("an operation id is a lowercase UUID, a colon and a decimal sequence number", () => {
  hegel.test(
    (tc) => {
      const groups = HEX_GROUPS.map((size) =>
        tc.draw(gs.text({ alphabet: "0123456789abcdef", minSize: size, maxSize: size })),
      );

      const uuid = groups.join("-");
      const at = tc.draw(gs.integers({ minValue: 0, maxValue: uuid.length }));
      const damage = tc.draw(gs.sampledFrom([undefined, "drop", "A", "g", "-", ":", " ", "0"]));

      const damaged =
        damage === undefined
          ? uuid
          : `${uuid.slice(0, at)}${damage === "drop" ? "" : damage}${uuid.slice(damage === "drop" ? at + 1 : at)}`;

      const sequence = tc.draw(gs.text({ alphabet: "0123456789", maxSize: 4 }));
      const suffix = tc.draw(gs.sampledFrom(["", "x", " ", ":1", "\n"]));
      const id = `${damaged}:${sequence}${suffix}`;

      expect(parseOperationId(id)).toEqual(
        damaged === uuid && sequence !== "" && suffix === ""
          ? { ok: true, value: id }
          : { ok: false, error: { code: "invalid-request" } },
      );
    },
    { testCases: 300 },
  );
});
