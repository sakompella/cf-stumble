import type { IsolateCommandName } from "./isolate-commands.generated.js";
import {
  awkWrites,
  curlWrites,
  sedWrites,
  sortWrites,
  xanWrites,
  yqWrites,
  writesAlways,
  writesNever,
  type WriteForm,
} from "./write-forms.js";

type IsolateProgram = Readonly<{ runs: "container" } | { runs: "isolate"; writes: WriteForm }>;

function inIsolate(writes: WriteForm): IsolateProgram {
  return { runs: "isolate", writes };
}

const PROGRAMS = {
  echo: inIsolate(writesNever),
  cat: inIsolate(writesNever),
  printf: inIsolate(writesNever),
  ls: inIsolate(writesNever),
  mkdir: inIsolate(writesAlways),
  rmdir: inIsolate(writesAlways),
  touch: inIsolate(writesAlways),
  rm: inIsolate(writesAlways),
  cp: inIsolate(writesAlways),
  mv: inIsolate(writesAlways),
  ln: inIsolate(writesAlways),
  chmod: inIsolate(writesAlways),
  pwd: inIsolate(writesNever),
  readlink: inIsolate(writesNever),
  head: inIsolate(writesNever),
  tail: inIsolate(writesNever),
  wc: inIsolate(writesNever),
  stat: inIsolate(writesNever),
  grep: inIsolate(writesNever),
  fgrep: inIsolate(writesNever),
  egrep: inIsolate(writesNever),
  rg: inIsolate(writesNever),
  sed: inIsolate(sedWrites),
  awk: inIsolate(awkWrites),
  sort: inIsolate(sortWrites),
  uniq: inIsolate(writesNever),
  comm: inIsolate(writesNever),
  cut: inIsolate(writesNever),
  paste: inIsolate(writesNever),
  tr: inIsolate(writesNever),
  rev: inIsolate(writesNever),
  nl: inIsolate(writesNever),
  fold: inIsolate(writesNever),
  expand: inIsolate(writesNever),
  unexpand: inIsolate(writesNever),
  strings: inIsolate(writesNever),
  split: inIsolate(writesAlways),
  column: inIsolate(writesNever),
  join: inIsolate(writesNever),
  tee: inIsolate(writesAlways),
  find: inIsolate(writesNever),
  basename: inIsolate(writesNever),
  dirname: inIsolate(writesNever),
  tree: inIsolate(writesNever),
  du: inIsolate(writesNever),
  env: { runs: "container" },
  printenv: inIsolate(writesNever),
  alias: inIsolate(writesNever),
  unalias: inIsolate(writesNever),
  history: inIsolate(writesNever),
  xargs: { runs: "container" },
  true: inIsolate(writesNever),
  false: inIsolate(writesNever),
  clear: inIsolate(writesNever),
  bash: { runs: "container" },
  sh: { runs: "container" },
  jq: inIsolate(writesNever),
  base64: inIsolate(writesNever),
  diff: inIsolate(writesNever),
  date: inIsolate(writesNever),
  sleep: inIsolate(writesNever),
  timeout: { runs: "container" },
  time: { runs: "container" },
  seq: inIsolate(writesNever),
  expr: inIsolate(writesNever),
  md5sum: inIsolate(writesNever),
  sha1sum: inIsolate(writesNever),
  sha256sum: inIsolate(writesNever),
  file: inIsolate(writesNever),
  "html-to-markdown": { runs: "container" },
  help: inIsolate(writesNever),
  which: inIsolate(writesNever),
  tac: inIsolate(writesNever),
  hostname: inIsolate(writesNever),
  whoami: inIsolate(writesNever),
  od: inIsolate(writesNever),
  gzip: inIsolate(writesAlways),
  gunzip: inIsolate(writesAlways),
  zcat: inIsolate(writesNever),
  tar: inIsolate(writesAlways),
  yq: inIsolate(yqWrites),
  xan: inIsolate(xanWrites),
  sqlite3: { runs: "container" },
  cd: inIsolate(writesNever),
  test: inIsolate(writesNever),
  curl: inIsolate(curlWrites),
} as const satisfies Readonly<Record<IsolateCommandName | "cd" | "test" | "curl", IsolateProgram>>;

type ProgramName = keyof typeof PROGRAMS;

function classified(name: string): name is ProgramName {
  return Object.hasOwn(PROGRAMS, name);
}

export const ISOLATE_PROGRAMS: ReadonlySet<string> = new Set(
  Object.entries<IsolateProgram>(PROGRAMS).flatMap(([name, program]) =>
    program.runs === "isolate" ? [name] : [],
  ),
);

export function isolateProgramWrites(name: string, args: readonly string[]): boolean {
  if (!classified(name)) return false;

  const program: IsolateProgram = PROGRAMS[name];

  if (program.runs === "container") return false;

  return program.writes(args);
}
