import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { JsonValue } from "../json.mts";
import type { TimeWindow } from "./check.mts";
import { pageRows, queryEvents } from "./telemetry.mts";

const EXEC_FINISHED_EVENT = "exec.finished";

export interface GitExec {
  readonly subcommand: string;
  readonly backend: string;
  readonly fellBack: boolean;
  readonly isolateRefused: boolean;
  readonly writeFormRefused: boolean;
}

export interface GitExecs {
  readonly execs: readonly GitExec[];
  readonly sample: boolean;
}

const ExecFinishedRow = Schema.Struct({
  source: Schema.Struct({
    event: Schema.String,
    program: Schema.String,
    backend: Schema.NullOr(Schema.String),
    fellBackFrom: Schema.NullOr(Schema.String),
    isolateRefused: Schema.Boolean,
    writeFormRefused: Schema.Boolean,
  }),
});

export function parseGitExecs(response: JsonValue): GitExecs {
  const { rows, sample } = pageRows(response);

  const execs = rows.flatMap((row): GitExec[] => {
    const parsed = Schema.decodeUnknownOption(ExecFinishedRow)(row);

    if (Option.isNone(parsed)) return [];

    const { event, program, backend, fellBackFrom, isolateRefused, writeFormRefused } =
      parsed.value.source;

    if (event !== EXEC_FINISHED_EVENT || (program !== "git" && !program.startsWith("git "))) {
      return [];
    }

    return [
      {
        subcommand: program === "git" ? "(none)" : program.slice("git ".length),
        backend: backend ?? "none",
        fellBack: fellBackFrom !== null,
        isolateRefused,
        writeFormRefused,
      },
    ];
  });

  return { execs, sample };
}

export async function fetchGitExecs(
  token: string,
  account: string,
  worker: string,
  window: TimeWindow,
): Promise<GitExecs> {
  return parseGitExecs(await queryEvents(token, account, worker, window, EXEC_FINISHED_EVENT));
}

function groupBy(execs: readonly GitExec[], key: keyof GitExec): Map<string, GitExec[]> {
  const groups = new Map<string, GitExec[]>();

  for (const exec of execs) {
    const name = String(exec[key]);
    groups.set(name, [...(groups.get(name) ?? []), exec]);
  }

  return groups;
}

function counted(execs: readonly GitExec[]): string {
  return [...groupBy(execs, "subcommand")]
    .map(([subcommand, group]) => ({ subcommand, count: group.length }))
    .toSorted((a, b) => b.count - a.count || a.subcommand.localeCompare(b.subcommand))
    .map(({ subcommand, count }) => `${subcommand} ${count}`)
    .join(", ");
}

function part(label: string, execs: readonly GitExec[]): string {
  return `${label} ${execs.length}${execs.length === 0 ? "" : ` (${counted(execs)})`}`;
}

const SAMPLE_NOTE = "; a sample: telemetry returned its row limit, use a shorter --since for all";

export function gitExecLine({ execs, sample }: GitExecs): readonly string[] {
  if (execs.length === 0) return [];

  const backends = groupBy(execs, "backend");
  const isolateShare = (100 * (backends.get("isolate")?.length ?? 0)) / execs.length;

  const parts = [
    ...[...backends]
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([backend, group]) => part(backend, group)),
    part(
      "fell back",
      execs.filter((exec) => exec.fellBack),
    ),
    part(
      "isolate refused",
      execs.filter((exec) => exec.isolateRefused),
    ),
    part(
      "write form refused",
      execs.filter((exec) => exec.writeFormRefused),
    ),
  ];

  return [
    `i git commands ${execs.length}, ${isolateShare.toFixed(1)}% in the isolate: ${parts.join("; ")}${sample ? SAMPLE_NOTE : ""}`,
  ];
}
