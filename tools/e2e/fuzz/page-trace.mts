import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as Schema from "effect/Schema";

const LOOKED_AT = ["auditProblems", "problems", "uncaughtExceptions", "consoleErrors", "sending"];

const Trace = Schema.Struct({
  violations: Schema.Array(Schema.Struct({ name: Schema.String })),
  snapshots: Schema.Array(
    Schema.Struct({ name: Schema.NullOr(Schema.String), value: Schema.Json }),
  ),
});

type Trace = typeof Trace.Type;

export type Violation = Readonly<{ property: string; detail: string }>;

function violatingEntries(outputPath: string): readonly Trace[] {
  const file = join(outputPath, "trace.jsonl");

  if (!existsSync(file)) return [];

  const decode = Schema.decodeUnknownSync(Schema.fromJsonString(Trace));

  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => decode(line))
    .filter((entry) => entry.violations.length > 0);
}

function describe(entry: Trace): string {
  return entry.snapshots
    .filter(({ name, value }) => LOOKED_AT.includes(name ?? "") && JSON.stringify(value) !== "[]")
    .map(({ name, value }) => `${name ?? ""}=${JSON.stringify(value)}`)
    .join("; ")
    .slice(0, 1200);
}

export function firstViolations(outputPath: string): readonly Violation[] {
  const first = new Map<string, Violation>();

  for (const entry of violatingEntries(outputPath)) {
    for (const { name } of entry.violations) {
      if (!first.has(name)) first.set(name, { property: name, detail: describe(entry) });
    }
  }

  return [...first.values()];
}
