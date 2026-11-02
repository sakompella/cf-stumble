import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { expect, test, vi } from "vitest";
import * as Schema from "effect/Schema";
import { logEvent, logRedactedCause, type LogFields } from "../src/diagnostics.js";

const githubToken = gs
  .text({
    alphabet: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
    minSize: 20,
    maxSize: 40,
  })
  .map((body) => `ghp_${body}`);

const jwt = gs
  .text({
    alphabet: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_",
    minSize: 8,
    maxSize: 30,
  })
  .map((part) => `eyJ${part}.eyJ${part}.${part}`);

const segmentBody = gs.text({
  alphabet: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_",
  minSize: 8,
  maxSize: 400,
});

const surrounding = gs.text({ alphabet: 'abc -:/="', maxSize: 20 });

const padding = gs.integers({ minValue: 0, maxValue: 300 }).map((length) => "x".repeat(length));

const decodeEntry = Schema.decodeUnknownSync(
  Schema.Record(
    Schema.String,
    Schema.Union([Schema.String, Schema.Number, Schema.Boolean, Schema.Null]),
  ),
);

const isText = Schema.is(Schema.String);

const fieldKey = gs.oneOf(
  gs.sampledFrom(["event", "level", "ts"]),
  gs.text({ alphabet: "abc_", minSize: 1, maxSize: 6 }),
);

const fieldValue = gs.oneOf<string | number | boolean | null>(
  gs.text({ maxSize: 400 }),
  gs.integers({ minValue: 0, maxValue: 400 }).map((length) => "y".repeat(length)),
  gs.integers(),
  gs.booleans(),
  gs.just(null),
);

test("no credential or JWT inside a string field reaches the log", () => {
  hegel.test((tc) => {
    const secret = tc.draw(gs.oneOf(githubToken, jwt));
    const value = `${tc.draw(surrounding)}${tc.draw(padding)}${secret}${tc.draw(surrounding)}`;
    const logged = vi.spyOn(console, "log").mockImplementation(() => {});

    logEvent("info", "github-credential.install", { detail: value, source: "configured-token" });

    const written = JSON.stringify(logged.mock.calls);
    logged.mockRestore();
    expect(written).not.toContain(secret.slice(0, 10));
    expect(written).toContain("configured-token");
  });
});

test("every logged event is one JSON-stable object that keeps its own event, level and time, and bounds its text", () => {
  hegel.test((tc) => {
    const event = tc.draw(gs.text({ alphabet: "abc.-", minSize: 1, maxSize: 12 }));
    const level = tc.draw(gs.sampledFrom(["info", "warn", "error"] as const));

    const fields: LogFields = Object.fromEntries(
      tc.draw(gs.arrays(gs.tuples(fieldKey, fieldValue), { maxSize: 5 })),
    );

    const consoles = [
      vi.spyOn(console, "log").mockImplementation(() => {}),
      vi.spyOn(console, "warn").mockImplementation(() => {}),
      vi.spyOn(console, "error").mockImplementation(() => {}),
    ];

    logEvent(level, event, fields);

    const calls = consoles.flatMap((spy) => spy.mock.calls);
    vi.restoreAllMocks();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(1);

    const entry = decodeEntry(calls[0]?.[0]);
    expect(JSON.parse(JSON.stringify(entry))).toEqual(entry);
    expect(entry).toMatchObject({ event, level });
    expect(Number.isNaN(Date.parse(String(entry.ts)))).toBe(false);
    expect(entry.ts).not.toBe(fields.ts);

    for (const [key, value] of Object.entries(fields)) {
      if (key === "event" || key === "level" || key === "ts") continue;

      expect(entry[key]).toBe(isText(value) ? value.slice(0, 200) : value);
    }
  });
});

test("no segment of a JWT inside a thrown cause reaches the log, wherever the cause is cut", () => {
  hegel.test((tc) => {
    const header = `eyJ${tc.draw(segmentBody)}`;
    const payload = `eyJ${tc.draw(segmentBody)}`;
    const signature = `sig${tc.draw(segmentBody)}`;
    const leading = "x".repeat(tc.draw(gs.integers({ minValue: 0, maxValue: 600 })));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    logRedactedCause(
      "example.step: unavailable",
      new Error(`${leading}${header}.${payload}.${signature}`),
    );

    const written = JSON.stringify(logged.mock.calls);
    logged.mockRestore();
    expect(written).toContain("example.step: unavailable");

    for (const segment of [header, payload, signature]) expect(written).not.toContain(segment);
  });
});
