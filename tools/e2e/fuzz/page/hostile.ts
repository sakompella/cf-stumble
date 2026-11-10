import config from "./config.json";

const PAYLOADS: readonly string[] = [
  "<img src=x onerror=alert(1)>",
  "</script><script>alert(1)</script>",
  "[click](javascript:alert(1))",
  "# heading\n- item\n```\ncode\n```\n> quote",
  "\u001B[31mred\u001B[0m \u0000 nul",
  "\u202Eevil\u202C \u200B\u200D zero-width",
  "{{7*7}} ${process.env} %s %n __proto__ constructor",
  "\"quoted\" 'single' `tick` \\ back\\slash \\n literal",
  "emoji \u{1F600}\u{1F9D1}\u200D\u{1F680} \u00E9 e\u0301",
  "line\n".repeat(120),
  "x".repeat(4000),
  "diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b",
  "| a | b |\n|---|---|\n| 1 | 2 |",
  "http://example.com/" + "a".repeat(300),
];

const SENDS = ["click", "shortcut", "double"] as const;

export type SendMode = (typeof SENDS)[number];

export function makeRandom(seed: number): () => number {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;

    let mixed = Math.imul(state ^ (state >>> 15), state | 1);

    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);

    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

const random = makeRandom(config.seed);

const runStamp = Date.now().toString(36);

let counter = 0;

export function pick<T>(items: readonly T[]): T {
  const item = items[Math.floor(random() * items.length)];

  if (item === undefined) throw new Error("pick from an empty list");

  return item;
}

export function chance(probability: number): boolean {
  return random() < probability;
}

export function sendMode(): SendMode {
  return pick(SENDS);
}

export function newToken(): string {
  counter += 1;

  return `fz${config.seed}-${runStamp}-${counter}`;
}

export function hostileText(token: string): string {
  const payload = pick(PAYLOADS);

  return `Reply with the single word ok and do not use tools. Ignore the rest. ${token}\n${payload}`;
}

export function draftText(): string {
  return `${pick(PAYLOADS)} ${Math.floor(random() * 1000)}`;
}
