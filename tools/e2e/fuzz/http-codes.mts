import { ERROR_STATUS, PROBLEM_STATUS } from "../../../src/api/problems.ts";

const PROBLEMS: readonly (readonly [string, number])[] = Object.entries(PROBLEM_STATUS);

export const KNOWN_CODES: ReadonlySet<string> = new Set(
  [...PROBLEMS, ...Object.entries(ERROR_STATUS)].flatMap(([code, status]) =>
    status === 500 ? [] : [code],
  ),
);

export const INTENDED_SERVER_CODES: ReadonlySet<string> = new Set(
  PROBLEMS.flatMap(([code, status]) => (status >= 500 ? [code] : [])),
);

export const EDGE_STATUSES: ReadonlySet<number> = new Set([400, 403, 405, 413, 414, 421, 431, 501]);

export const LEAK_PATTERNS: readonly RegExp[] = [
  /gh[pousr]_[A-Za-z0-9]{20,}/u,
  /github_pat_[A-Za-z0-9_]{20,}/u,
  /eyJ[\w-]{10,}\.eyJ[\w-]{10,}/u,
  /BEGIN [A-Z ]*PRIVATE KEY/u,
  /sk-[A-Za-z0-9]{24,}/u,
];

export const INTERNAL_PATTERNS: readonly RegExp[] = [
  /\n\s+at \S+ \(/u,
  /node_modules/u,
  /\.(?:ts|js|mjs):\d+:\d+/u,
  /\b(?:TypeError|RangeError|ReferenceError|SyntaxError)\b/u,
];
