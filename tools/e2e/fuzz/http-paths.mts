import type { Random } from "./random.mts";

const SEGMENT_NOISE = [
  "/",
  "//",
  "/.",
  "/..",
  "/%2e",
  "/%2e%2e",
  "%2f",
  "%2F",
  ";x=1",
  "/index.html",
  "%00",
  "%0a",
  "%0d%0a",
  "%25",
  "%2525",
  "%c0%af",
  "%ff",
  "%e2%80%ae",
  "%f0%9f%92%a9",
  "%u0041",
  "%5c",
  "\\",
  "\u00E9",
  "\u00FF",
  "%",
  "%zz",
  "%e0%80",
  "~",
  "*",
  "'",
  '"',
  "<script>",
  "{}",
  "|",
  "^",
  "`",
];

export const QUERIES = [
  "?",
  "?a=b",
  "?from=0",
  "?from=-1",
  "?from=1.5",
  "?from=999999999999999",
  "?from=9999999999999999",
  "?from=abc",
  "?from=",
  "?from=1&from=2",
  "?limit=0",
  "?limit=1",
  "?limit=100",
  "?limit=101",
  "?limit=-5",
  "?limit=1e2",
  "?limit=%31%30",
  "?order=ascending",
  "?order=descending&limit=3",
  "?order=ASC",
  "?order=",
  "?min=0&max=0",
  "?min=5&max=1",
  "?min=abc",
  "?max=99999999999999999999",
  "?min=0&max=999999999999999&limit=100&order=ascending",
  "?%",
  "?&&&",
  "?=",
  "?a[]=1&a[]=2",
  "?__proto__=1",
  "?from=\u00E9",
];

function sprinkle(random: Random, path: string): string {
  const at = random.int(path.length + 1);

  return `${path.slice(0, at)}${random.pick(SEGMENT_NOISE)}${path.slice(at)}`;
}

function flipCase(random: Random, path: string): string {
  const at = random.int(path.length);

  return `${path.slice(0, at)}${path.charAt(at).toUpperCase()}${path.slice(at + 1)}`;
}

function encodeOne(random: Random, path: string): string {
  const at = random.int(path.length);
  const code = (path.codePointAt(at) ?? 0).toString(16).padStart(2, "0");

  return `${path.slice(0, at)}%${random.chance(0.5) ? code : code.toUpperCase()}${path.slice(at + 1)}`;
}

function longer(random: Random, path: string): string {
  const size = random.pick([300, 1_000, 4_000, 8_000, 15_000, 20_000, 70_000]);

  return random.chance(0.5)
    ? `${path}/${"a".repeat(size)}`
    : `${path}?q=${random.pick(["a", "%41", "\u00E9"]).repeat(size)}`;
}

function dotSegments(random: Random, path: string): string {
  const parts = path.split("/").slice(1);
  const at = random.int(parts.length + 1);

  parts.splice(at, 0, random.pick([".", "..", "%2e", "%2e%2e", ".%2e", "%2e."]));

  return `/${parts.join("/")}`;
}

export function mutatePath(random: Random, path: string): string {
  const steps = random.between(1, 3);
  let current = path;

  for (let step = 0; step < steps; step += 1) {
    const mutation = random.weighted([
      [4, sprinkle],
      [2, flipCase],
      [3, encodeOne],
      [1, longer],
      [3, dotSegments],
      [3, (_random: Random, text: string) => `${text}${random.pick(QUERIES)}`],
      [2, (_random: Random, text: string) => `/${text}`],
      [2, (_random: Random, text: string) => `${text}/`],
    ]);

    current = mutation(random, current);
  }

  return current;
}

export function randomQuery(random: Random): string {
  return random.pick(QUERIES);
}
