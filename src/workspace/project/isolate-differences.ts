const REDIRECT = /^\d*(?:<|>>?)(?:&\d+)?$/u;

const REDIRECT_WITH_TARGET = /^\d*(?:<|>>?)[^&]/u;

function operandsAndOptions(words: readonly string[]) {
  const operands: string[] = [];
  const options: string[] = [];

  for (let index = 0; index < words.length; index++) {
    const word = words[index] ?? "";

    if (REDIRECT.test(word)) index += word.includes("&") ? 0 : 1;
    else if (REDIRECT_WITH_TARGET.test(word)) continue;
    else if (word.startsWith("-") && word !== "-") options.push(word);
    else operands.push(word);
  }

  return { operands, options };
}

function hasShortOption(options: readonly string[], letters: string): boolean {
  return options.some(
    (word) => !word.startsWith("--") && letters.split("").some((letter) => word.includes(letter)),
  );
}

const COUNT_OPTIONS = new Set(["-l", "-w", "-c", "-m"]);

type Invocation = ReturnType<typeof operandsAndOptions>;

const DIFFERS = new Map<string, (invocation: Invocation) => boolean>([
  ["ls", ({ operands }) => operands.length > 1],
  ["cut", ({ options }) => hasShortOption(options, "f")],
  ["chmod", () => true],
  ["du", () => true],
  ["echo", ({ options }) => hasShortOption(options, "eE")],
  [
    "wc",
    ({ operands, options }) =>
      operands.length > 1 || !(options.length === 1 && COUNT_OPTIONS.has(options[0] ?? "")),
  ],
  ["uniq", ({ options }) => hasShortOption(options, "c")],
  ["awk", ({ operands }) => operands.some((word) => /\b(?:for|while|do)\b/u.test(word))],
  ["grep", ({ options }) => hasShortOption(options, "rR") || options.includes("--recursive")],
]);

export function differsFromTheContainer(program: string, rest: readonly string[]): boolean {
  return DIFFERS.get(program)?.(operandsAndOptions(rest)) ?? false;
}

export function mergesStderrIntoStdout(words: readonly string[]): boolean {
  return words.some((word) => /^\d*>&/u.test(word));
}

export function hasUnquotedPatternCharacter(command: string): boolean {
  let quote: string | undefined;

  for (const char of command) {
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
    } else if (char === "'" || char === '"') {
      quote = char;
    } else if (char === "?" || char === "[") {
      return true;
    }
  }

  return false;
}
