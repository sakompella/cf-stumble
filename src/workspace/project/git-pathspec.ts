export function rooted(path: string, prefix: string): string | undefined {
  const parts = prefix.split("/").filter((part) => part !== "");
  let rest = path.startsWith("./") ? path.slice(2) : path;

  if (rest === ".") rest = "";

  for (const part of rest.split("/")) {
    if (part === "" || part === ".") continue;

    if (part === "..") {
      if (parts.pop() === undefined) return undefined;

      continue;
    }

    parts.push(part);
  }

  return parts.length === 0 ? "." : parts.join("/");
}

export function under(path: string, spec: string): boolean {
  const bare = spec.replace(/\/$/u, "");

  return bare === "." || path === bare || path.startsWith(`${bare}/`) || path === `${bare}/`;
}

export const WILDCARD = /[*?[\\]/u;

const REGEX_SPECIAL = /[.+^${}()|\\\]]/u;

const WILD = new Map([
  ["*", "[^]*"],
  ["?", "[^]"],
]);

function literal(char: string): string {
  return REGEX_SPECIAL.test(char) ? `\\${char}` : char;
}

function bracket(pattern: string, start: number): readonly [string, number] | undefined {
  const negated = pattern[start + 1] === "!" || pattern[start + 1] === "^";
  const first = start + (negated ? 2 : 1);
  const close = pattern.indexOf("]", first + 1);

  if (close === -1) return undefined;

  const members = pattern
    .slice(first, close)
    .replaceAll("\\", "\\\\")
    .replace(/^\]/u, String.raw`\]`);

  return [`[${negated ? "^" : ""}${members}]`, close + 1];
}

function wildcard(pattern: string): RegExp {
  let body = "";
  let index = 0;

  while (index < pattern.length) {
    const char = pattern[index] ?? "";

    if (char === "\\" && index + 1 < pattern.length) {
      body += literal(pattern[index + 1] ?? "");
      index += 2;
    } else if (char === "[") {
      const group = bracket(pattern, index);

      body += group === undefined ? literal(char) : group[0];
      index = group === undefined ? index + 1 : group[1];
    } else {
      body += WILD.get(char) ?? literal(char);
      index += 1;
    }
  }

  return new RegExp(`^${body}$`, "u");
}

export function matching(files: readonly string[], at: string): readonly string[] {
  if (!WILDCARD.test(at)) return files.filter((file) => under(file, at));

  const pattern = wildcard(at);

  return files.filter((file) => pattern.test(file));
}

export function matchesAny(path: string, specs: readonly string[]): boolean {
  return specs.some((spec) => matching([path], spec).length > 0);
}

export function resolveSpecs(
  paths: readonly string[],
  prefix: string,
): readonly string[] | { readonly outside: string } {
  const specs: string[] = [];

  for (const path of paths) {
    const at = rooted(path, prefix);

    if (at === undefined) return { outside: path };

    specs.push(at);
  }

  return specs;
}
