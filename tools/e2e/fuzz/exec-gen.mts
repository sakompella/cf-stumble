import { BIG, CONTAINER_ONLY, EXITS, LIMITS } from "./exec-gen-fixed.mts";

export class Rng {
  #state: number;

  constructor(seed: number) {
    this.#state = seed >>> 0;
  }

  next(): number {
    this.#state = (this.#state + 0x6d2b79f5) >>> 0;

    let value = this.#state;

    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);

    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  }

  int(limit: number): number {
    return Math.floor(this.next() * limit);
  }

  chance(probability: number): boolean {
    return this.next() < probability;
  }

  pick<T>(items: readonly T[]): T {
    const item = items[this.int(items.length)];

    if (item === undefined) throw new Error("nothing to pick from");

    return item;
  }
}

export type Fixture = Readonly<{ path: string; base64: string }>;

export type Case = Readonly<{
  id: number;
  command: string;
  fixtures: readonly Fixture[];
  timeout: number | undefined;
}>;

const WORDS = [
  "alpha",
  "beta",
  "gamma",
  "delta",
  "Alpha",
  "beta",
  "x1",
  "42",
  "7",
  "-3",
  "",
  "a b",
  "é",
  "✓",
  "日本語",
  "😀",
  "مرحبا",
  "tab\there",
  "q'uote",
  'd"q',
  "$HOME",
  "*",
  "a\\b",
];

const FILES = [
  "a.txt",
  "b.txt",
  "c.log",
  "d.csv",
  "sp ace.txt",
  "ü.txt",
  "sub/x.txt",
  "empty.txt",
  ".hidden",
];

const SHORT = ["a.txt", "b.txt", "c.log", "d.csv", "empty.txt"];

function content(rng: Rng, name: string): string {
  if (name === "empty.txt") return "";

  const lines = Array.from({ length: 1 + rng.int(8) }, () => {
    const cells = Array.from({ length: 1 + rng.int(4) }, () => rng.pick(WORDS));

    return name.endsWith(".csv") ? cells.join(",") : cells.join(" ");
  });

  const ending = rng.pick(["\n", "\n", "", "\r\n"]);

  return lines.join(ending === "\r\n" ? "\r\n" : "\n") + ending;
}

function fixtures(rng: Rng): readonly Fixture[] {
  const names = new Set<string>([...SHORT.slice(0, 2 + rng.int(3)), "sub/x.txt"]);

  for (const name of FILES) if (rng.chance(0.25)) names.add(name);

  const files = [...names].map((name) => ({
    path: name,
    base64: Buffer.from(content(rng, name), "utf8").toString("base64"),
  }));

  if (!rng.chance(0.2)) return files;

  return [
    ...files,
    { path: "bin.dat", base64: Buffer.from([0xff, 0xfe, 0, 65, 10, 0x80]).toString("base64") },
  ];
}

const file = (rng: Rng): string => rng.pick(SHORT);

const quoted = (rng: Rng, text: string): string => rng.pick([`'${text}'`, `"${text}"`, text]);

const FILTERS = [
  (rng: Rng) => `head -n ${1 + rng.int(4)}`,
  (rng: Rng) => `tail -n ${1 + rng.int(4)}`,
  () => "sort",
  () => "sort -r",
  () => "sort -u",
  () => "sort -n",
  () => "uniq",
  () => "uniq -c",
  () => "wc -l",
  () => "wc -c",
  () => "wc -w",
  () => "rev",
  () => "nl",
  () => "tr a-z A-Z",
  () => "tr -d aeiou",
  () => "tr -s ' '",
  () => "cut -c1-3",
  () => "cut -d' ' -f1",
  () => "cut -d, -f2",
  (rng: Rng) => `sed ${quoted(rng, "s/a/X/g")}`,
  (rng: Rng) => `sed -n ${quoted(rng, "2,3p")}`,
  (rng: Rng) => `sed ${quoted(rng, "1d")}`,
  (rng: Rng) => `awk ${quoted(rng, "{print $1}")}`,
  (rng: Rng) => `awk ${quoted(rng, '{print NR":"$0}')}`,
  (rng: Rng) => `awk -F, ${quoted(rng, "{print $NF}")}`,
  (rng: Rng) =>
    `grep ${rng.pick(["-i", "-v", "-c", "-n", "-E", ""])} ${quoted(rng, rng.pick(["a", "^b", "é", "[0-9]+", "x$"]))}`.replace(
      "  ",
      " ",
    ),
  () => "fold -w 5",
  () => "base64",
  () => "tac",
  () => "od -c",
];

const SOURCES = [
  (rng: Rng) => `cat ${file(rng)}`,
  (rng: Rng) => `cat ${file(rng)} ${file(rng)}`,
  (rng: Rng) =>
    `printf ${quoted(rng, rng.pick(["%s\\n", "%5s|%-5s|\\n", "%d\\n", "a\\tb\\n", "%x\\n", "\\u00e9\\n", "%s %s\\n"]))} ${rng.pick(["1", "two", "é", "'a b'", "255"])} ${rng.pick(["", "x", "3"])}`,
  (rng: Rng) =>
    `echo ${rng.pick(["-n", ""])} ${quoted(rng, rng.pick(WORDS))} ${quoted(rng, rng.pick(WORDS))}`,
  (rng: Rng) => `seq ${1 + rng.int(3)} ${rng.pick([1, 5, 20, 100])}`,
  () => "ls",
  () => "ls -1",
  () => "ls *.txt",
  () => "ls ?.txt",
  () => "ls [ab].txt",
  () => "ls {a,b}.txt",
  () => "find . -name '*.txt' | sort",
  () => "find . -type f | sort",
  (rng: Rng) => `head -c ${1 + rng.int(20)} ${file(rng)}`,
  (rng: Rng) => `paste ${file(rng)} ${file(rng)}`,
  (rng: Rng) => `diff ${file(rng)} ${file(rng)}`,
  (rng: Rng) => `comm ${file(rng)} ${file(rng)}`,
  (rng: Rng) => `md5sum ${file(rng)}`,
  (rng: Rng) => `sha256sum ${file(rng)}`,
  (rng: Rng) => `expr ${rng.int(50)} ${rng.pick(["+", "-", "*", "/"])} ${1 + rng.int(9)}`,
  (rng: Rng) => `grep -r ${quoted(rng, "a")} .`,
  (rng: Rng) => `wc ${file(rng)}`,
  (rng: Rng) => `basename ${quoted(rng, "/x/y/z.txt")} .txt`,
  () => "pwd",
];

const SIDE_EFFECTS = [
  (rng: Rng) => `mkdir -p ${rng.pick(["n", "n/m", "sub", "q/r/s"])}`,
  (rng: Rng) => `touch ${rng.pick(["t1", "t 2", "ü2", "sub/t3"])}`,
  (rng: Rng) => `cp ${file(rng)} ${rng.pick(["copy.txt", "sub/c.txt", "ü.copy"])}`,
  (rng: Rng) => `mv ${file(rng)} ${rng.pick(["moved.txt", "mv 2.txt"])}`,
  (rng: Rng) => `rm -f ${file(rng)}`,
  (rng: Rng) => `rm -rf ${rng.pick(["sub", "n", "nothing"])}`,
  (rng: Rng) => `ln -s ${file(rng)} ${rng.pick(["lnk", "lnk2"])}`,
  (rng: Rng) => `chmod +x ${file(rng)}`,
  (rng: Rng) => `printf 'one\\ntwo\\n' | tee ${rng.pick(["tee.out", "sub/tee.out"])}`,
  (rng: Rng) => `echo hi >> ${rng.pick(["a.txt", "new.txt", "sub/new.txt"])}`,
  (rng: Rng) => `echo ${quoted(rng, rng.pick(WORDS))} > ${rng.pick(["o1", "o 2", "ö3"])}`,
];

const DECORATIONS = [
  () => "",
  () => "",
  () => " 2>&1",
  () => " 2>/dev/null",
  () => " > out.txt",
  () => " > out.txt 2>&1",
  () => " >> out.txt",
  () => " > /dev/null",
];

function simple(rng: Rng): string {
  const source = rng.pick(SOURCES)(rng);
  const filters = Array.from({ length: rng.int(3) }, () => rng.pick(FILTERS)(rng));

  return [source, ...filters].join(" | ");
}

function chained(rng: Rng): string {
  const first = simple(rng);
  const listsDirectory = /\b(ls|find|tree|du)\b|grep -r/u.test(first);
  const parts = [first + (listsDirectory ? "" : rng.pick(DECORATIONS)())];

  while (rng.chance(0.4)) {
    const next = rng.chance(0.3) ? rng.pick(SIDE_EFFECTS)(rng) : simple(rng);

    parts.push(rng.pick([" && ", " || ", "; "]), next);
  }

  return parts.join("");
}

function commandFor(rng: Rng): string {
  const roll = rng.next();

  if (roll < 0.1) return rng.pick(EXITS);

  if (roll < 0.22) return rng.pick(CONTAINER_ONLY);

  if (roll < 0.3) return rng.pick(BIG)(rng);

  if (roll < 0.4) return rng.pick(SIDE_EFFECTS)(rng);

  if (roll < 0.5)
    return `cd ${rng.pick(["sub", "..", "."])} && ${rng.pick(["pwd", "ls", "cat x.txt", "echo here"])}`;

  return chained(rng);
}

export function generateCase(rng: Rng, id: number): Case {
  if (rng.chance(0.04)) {
    const limit = rng.pick(LIMITS);

    return { id, command: limit.command, fixtures: fixtures(rng), timeout: limit.timeout };
  }

  return { id, command: commandFor(rng), fixtures: fixtures(rng), timeout: 30 };
}
