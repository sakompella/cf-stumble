export type Backend = "isolate" | "container";

export type Case = Readonly<{
  kind: string;
  backend: Backend;
  command: string;
  oracle?: string;
}>;

export function signature(command: string): string {
  const [, subcommand = "", ...rest] = command.split(/\s+/u);
  const flags = rest.filter((word) => word.startsWith("-")).slice(0, 2);

  return [subcommand, ...flags].join(" ");
}

export type Random = Readonly<{
  next(): number;
  int(below: number): number;
  chance(probability: number): boolean;
  pick<T>(items: readonly T[]): T;
}>;

export function random(seed: number): Random {
  let state = seed >>> 0;

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);

    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);

    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };

  return {
    next,
    int: (below) => Math.floor(next() * below),
    chance: (probability) => next() < probability,
    pick: (items) => {
      const item = items[Math.floor(next() * items.length)];

      if (item === undefined) throw new Error("pick from an empty list");

      return item;
    },
  };
}

export const NAMES = [
  "a.txt",
  "b.txt",
  "c.md",
  "src/x.ts",
  "src/y.ts",
  "docs/readme.md",
  "sp ace.txt",
  "d/e/f/g/deep.txt",
  "ünï.txt",
  ".hidden",
  "UPPER.TXT",
  "src/sub/z.ts",
];

export const DIRS = ["src", "docs", "d", "d/e", "src/sub", "newdir"];

export const MESSAGES = [
  "first",
  "fix: handle the thing",
  'it has spaces and "quotes"',
  "dollar $HOME and `ticks`",
  "ünï ✓",
  "a very long subject ".repeat(8).trim(),
  "line one",
  "-leading dash",
  "tab\tsep",
];

export const LINES = ["alpha", "beta", "gamma", "delta", "l1", "l2", "same", "x y z"];

export function quote(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

export function path(name: string): string {
  return name.startsWith("-") ? `./${name}` : name;
}

export const READS: readonly string[] = [
  "status",
  "status -s",
  "status --short -b",
  "status --porcelain",
  "status --porcelain=v1 -b",
  "status -uno",
  "status -u",
  "status -uall",
  "status --short --untracked-files=all",
  "status --branch --short",
  "diff",
  "diff --stat",
  "diff --cached",
  "diff --cached --stat",
  "diff HEAD",
  "diff --name-only",
  "diff --name-status",
  "diff --cached --name-status",
  "diff --shortstat",
  "diff --numstat",
  "diff --exit-code --quiet",
  "ls-files",
  "ls-files -s",
  "ls-files -m",
  "ls-files -o",
  "ls-files --others --exclude-standard",
  "branch",
  "branch -v",
  "branch -vv",
  "branch --list",
  "branch -a",
  "rev-parse HEAD",
  "rev-parse --abbrev-ref HEAD",
  "rev-parse --short HEAD",
  "symbolic-ref HEAD",
  "show --stat --format=%s",
  "show HEAD --name-only --format=",
  "cat-file -p HEAD^{tree}",
];

export const HISTORY: readonly string[] = [
  "log",
  "log --oneline",
  "log --format=%s",
  "log -n 2 --format=%s",
  "log -1",
  "log --stat",
  "log --graph --oneline",
  "log --all --oneline",
  "log --name-only --format=%s",
  "log --format=%an:%ae:%s",
  "log --oneline -- docs",
  "reset --soft HEAD~1",
  "reset --mixed HEAD~1",
  "reset --hard",
  "reset --hard HEAD~1",
  "reset --hard HEAD",
  "reset HEAD~1",
  "reset --keep HEAD",
  "reset --soft HEAD",
];

export const KNOWN: readonly string[] = ["fs:append"];
