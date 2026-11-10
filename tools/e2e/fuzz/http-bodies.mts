import type { BodySpec } from "./http-case.mts";
import type { RouteBody } from "./http-routes.mts";
import type { Random } from "./random.mts";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

type JsonRecord = Readonly<Record<string, JsonValue>>;

const NASTY_STRINGS = [
  "",
  " ",
  "\n\n",
  "\u0000",
  "\uD800",
  "\uDFFF\uD800",
  "\u{1F4A9}",
  "\u202Eevil",
  "\u200B",
  "\uFEFF",
  "a\r\nb: c",
  "\u00E9",
  "../../etc/passwd",
  "<script>alert(1)</script>",
  "${process.env}",
  "{{7*7}}",
  "__proto__",
  "constructor",
  "%s%s%s%n",
  "-1",
  "NaN",
  "null",
  "'; DROP TABLE x;--",
  "\u0301".repeat(500),
  "a".repeat(129),
  "a".repeat(1_000),
  "a".repeat(100_001),
];

const NASTY_VALUES: readonly JsonValue[] = [
  null,
  true,
  false,
  0,
  -0,
  -1,
  1,
  1.5,
  1e308,
  2 ** 53,
  2 ** 53 + 2,
  Number.MIN_VALUE,
  [],
  {},
  [[]],
  { a: { b: { c: {} } } },
  [null],
];

const REPOSITORY_URLS = [
  "https://github.com/octocat/fz-does-not-exist",
  "http://github.com/a/b",
  "ssh://git@github.com/a/b",
  "git@github.com:a/b.git",
  "https://github.com/a",
  "https://github.com/",
  "https://user:pass@github.com/a/b",
  "https://github.com/a/b?x=1",
  "https://github.com/a/b#frag",
  "file:///etc/passwd",
  "https://169.254.169.254/a/b",
  "https://gitlab.com/a/b",
  "https://github.com/../..",
  "https://github.com/a/b/c/d",
  "https://github.com/a/b.git.git",
  "https://GITHUB.com/A/B",
  "https://github.com/\u00E9/\u00E9",
  "javascript:alert(1)",
  `https://github.com/${"a".repeat(5_000)}/b`,
  "",
];

function hex(random: Random, length: number): string {
  return Array.from({ length }, () => random.int(16).toString(16)).join("");
}

const REQUEST_IDS = ["r1", "", "a".repeat(128), "a".repeat(129)];

const VALID_VALUES: Readonly<Record<RouteBody, (random: Random) => JsonRecord>> = {
  connect: (random) => ({
    repositoryUrl: random.chance(0.5)
      ? `https://github.com/fz-${hex(random, 8)}/nope-${hex(random, 6)}`
      : random.pick(REPOSITORY_URLS),
    ...(random.chance(0.3) && { displayName: random.pick(NASTY_STRINGS) }),
  }),
  submit: (random) => ({
    harnessCommit: random.pick([
      hex(random, 40),
      hex(random, 64),
      hex(random, 39),
      "g".repeat(40),
      hex(random, 40).toUpperCase(),
    ]),
  }),
  control: (random) => ({
    label: random.pick([1, 2, 3, 0, -1, 99, 2 ** 31, 2 ** 53]),
    observedEpoch: random.pick([0, 1, 2, 5, -1, 1.5]),
  }),
  complete: (random) => ({
    attemptId: random.pick(NASTY_STRINGS),
    callbackUrl: random.pick([
      "http://localhost:1455/auth/callback?code=x&state=y",
      "",
      "not a url",
      "https://evil.example/?code=1",
      ...NASTY_STRINGS,
    ]),
  }),
  backend: (random) => ({
    backend: random.pick(["cloudflare", "Cloudflare", "provider ", "orb", "", "__proto__"]),
  }),
  message: (random) => ({
    content: random.pick(NASTY_STRINGS),
    requestId: random.pick([hex(random, 32), ...REQUEST_IDS, ...NASTY_STRINGS.slice(0, 12)]),
  }),
  none: () => ({}),
};

function structural(random: Random, record: JsonRecord): JsonValue {
  const keys = Object.keys(record);
  const key = random.pick([...keys, "x"]);

  switch (random.int(7)) {
    case 0:
      return Object.fromEntries(Object.entries(record).filter(([name]) => name !== key));
    case 1:
      return {
        ...record,
        [random.pick([
          "extra",
          "__proto__",
          "constructor",
          "$schema",
          "",
          "a".repeat(1_000),
          "\u0000",
        ])]: random.pick(NASTY_VALUES),
      };
    case 2:
      return random.pick(NASTY_VALUES);
    case 3:
      return [record];
    case 4:
      return { ...record, [key]: random.pick(NASTY_VALUES) };
    case 5:
      return { ...record, [key]: random.pick(NASTY_STRINGS) };
    default:
      return Object.fromEntries(
        Object.entries(record).map(([name, item]) => [
          name,
          random.chance(0.5) ? random.pick(NASTY_STRINGS) : item,
        ]),
      );
  }
}

export type GeneratedBody = Readonly<{ spec: BodySpec | undefined }>;

const BIG_SIZES = [100_001, 500_000, 2_000_000, 8_000_000];

const BIG_KEYS = [
  "content",
  "repositoryUrl",
  "callbackUrl",
  "attemptId",
  "displayName",
  "harnessCommit",
  "x",
];

function bigBody(random: Random, kind: RouteBody, huge: boolean): BodySpec {
  const size = huge ? random.pick([40_000_000, 80_000_000]) : random.pick(BIG_SIZES);
  const other = kind === "message" ? ',"requestId":"r"' : "";

  return {
    kind: "repeat",
    prefix: `{"${random.pick(BIG_KEYS)}":"`,
    unit: "a",
    count: size,
    suffix: `"${other}}`,
  };
}

function deepBody(random: Random): BodySpec {
  const depth = random.pick([100, 1_000, 10_000, 100_000, 1_000_000]);

  return random.chance(0.5)
    ? { kind: "nest", open: "[", close: "]", depth, core: "" }
    : { kind: "nest", open: '{"a":', close: "}", depth, core: "1" };
}

const INVALID_BYTES = [
  [0xff],
  [0xc0, 0xaf],
  [0xed, 0xa0, 0x80],
  [0xf8, 0x88, 0x80, 0x80, 0x80],
  [0x80],
];

function withInvalidUtf8(random: Random, text: string): BodySpec {
  const bytes = Buffer.from(text, "utf8");
  const at = random.int(bytes.length + 1);
  const junk = Buffer.from(random.pick(INVALID_BYTES));

  return {
    kind: "bytes",
    hex: Buffer.concat([bytes.subarray(0, at), junk, bytes.subarray(at)]).toString("hex"),
  };
}

function rawText(random: Random, text: string): BodySpec {
  if (random.chance(0.15)) return withInvalidUtf8(random, text);

  const variants = [
    text.slice(0, random.int(text.length + 1)),
    `\uFEFF${text}`,
    `${text},`,
    `${text}${text}`,
    `${text}\u0000`,
    text.replaceAll('"', "'"),
    text.replace(/\{/u, "{,"),
    text.replace(/\}$/u, ',"a":1,"a":2}'),
    `/*c*/${text}`,
    "",
    " \n\t ",
    "NaN",
    '{"a":1e999}',
    '{"a":-1e999}',
    "undefined",
    `{"__proto__":${text}}`,
    '{"__proto__":{"polluted":true}}',
    '{"constructor":{"prototype":{"polluted":true}}}',
  ];

  return { kind: "text", text: random.pick(variants) };
}

export function generateBody(random: Random, kind: RouteBody, allowHuge: boolean): GeneratedBody {
  const roll = random.int(100);

  if (roll < 12) return { spec: undefined };

  if (allowHuge && roll < 14) return { spec: bigBody(random, kind, true) };

  if (roll < 20) return { spec: bigBody(random, kind, false) };

  if (roll < 26) return { spec: deepBody(random) };

  const base = VALID_VALUES[kind](random);
  const text = JSON.stringify(random.chance(0.35) ? base : structural(random, base));

  return { spec: roll < 38 ? rawText(random, text) : { kind: "text", text } };
}
