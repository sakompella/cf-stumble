import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { expect, test } from "vitest";
import { routedBackend } from "../../../src/workspace/project/exec-selection.js";
import { ISOLATE_PROGRAMS } from "../../../src/workspace/project/isolate-programs.js";

const SYSTEM_DIRECTORIES = [
  "/bin",
  "/dev",
  "/etc",
  "/home",
  "/lib",
  "/lib64",
  "/media",
  "/mnt",
  "/opt",
  "/proc",
  "/root",
  "/run",
  "/sbin",
  "/srv",
  "/sys",
  "/tmp",
  "/usr",
  "/var",
];

const WORKSPACE_PATHS = ["/", "/workspace", "/workspace/src/a.ts", "/tmpx", "/devices"];

const CONTAINER_PROGRAMS = ["node", "pnpm", "npx", "python3", "./run.sh", "xargs", "env", "for"];

const SAFE_NAMES = ["FOO", "A1", "_x", "lower", "ENVIRONMENT", "XLD_PATH", "PATHS"];

const UNSAFE_NAMES = [
  "PATH",
  "IFS",
  "SHELL",
  "ENV",
  "BASH_ENV",
  "LD_PRELOAD",
  "DYLD_LIBRARY_PATH",
  "1A",
  "A-B",
];

const FIND_FLAGS = ["-exec", "-execdir", "-ok", "-okdir", "-delete"];

const SEPARATORS = [" | ", "|", "; ", ";", " && ", "&&", " || ", " & ", "&", "\n"];

const UNREADABLE = [
  "$(id)",
  '"$(id)"',
  "`id`",
  '"`id`"',
  "'`'`id`",
  "(",
  ")",
  "{",
  "}",
  "a\\ b",
  '"\\"',
  "<<EOF",
];

const UNTERMINATED = ["'open", '"open', "'"];

interface Word {
  readonly text: string;
  readonly path: string | undefined;
  readonly flag: boolean;
}

interface Segment {
  readonly words: readonly string[];
  readonly isolate: boolean;
  readonly outside: boolean;
}

const unquotedText = gs.text({ alphabet: "abxyz019._-+:,@%=*$", minSize: 1, maxSize: 4 });

const quotedText = gs.oneOf(
  gs.text({ alphabet: 'a |;&$`(){}\\<>\n"/=', maxSize: 5 }).map((value) => `'${value}'`),
  gs.text({ alphabet: "a |;&'(){}<>\n/=", maxSize: 5 }).map((value) => `"${value}"`),
);

function quoted(tc: hegel.TestCase, value: string): string {
  const quote = tc.draw(gs.sampledFrom(["", "'", '"']));

  return `${quote}${value}${quote}`;
}

function isSystemPath(path: string): boolean {
  return (
    path !== "/dev/null" &&
    SYSTEM_DIRECTORIES.some((directory) => path === directory || path.startsWith(`${directory}/`))
  );
}

function pick<T>(tc: hegel.TestCase, clean: boolean, usual: readonly T[], rare: readonly T[]): T {
  const fromRare = !clean && tc.draw(gs.integers({ minValue: 0, maxValue: 5 })) === 0;

  return tc.draw(gs.sampledFrom(fromRare ? rare : usual));
}

function drawPath(tc: hegel.TestCase, clean: boolean): string {
  if (tc.draw(gs.integers({ minValue: 0, maxValue: 7 })) === 0) return "/dev/null";

  const base = pick(tc, clean, WORKSPACE_PATHS, SYSTEM_DIRECTORIES);

  return `${base}${tc.draw(gs.sampledFrom(["", "/x", "/a/b.txt"]))}`;
}

function drawArgument(tc: hegel.TestCase, clean: boolean): Word {
  const kind = pick(tc, clean, ["text", "assignment", "fd", "path", "redirect"], ["flag"]);

  if (kind === "flag") {
    return { text: quoted(tc, tc.draw(gs.sampledFrom(FIND_FLAGS))), path: undefined, flag: true };
  }

  if (kind === "path" || kind === "redirect") {
    const path = drawPath(tc, clean);
    const operator = kind === "path" ? "" : tc.draw(gs.sampledFrom([">", ">>", "<", "2>", "1> "]));

    return { text: `${operator}${quoted(tc, path)}`, path, flag: false };
  }

  const text =
    kind === "assignment"
      ? `${tc.draw(gs.sampledFrom(UNSAFE_NAMES))}=x`
      : kind === "fd"
        ? tc.draw(gs.sampledFrom(["2>&1", ">&2", "1>&2"]))
        : tc
            .draw(gs.arrays(gs.oneOf(unquotedText, quotedText), { minSize: 1, maxSize: 3 }))
            .join("");

  return { text, path: undefined, flag: false };
}

function drawSegment(tc: hegel.TestCase, clean: boolean): Segment {
  const names = tc
    .draw(gs.arrays(gs.just(0), { maxSize: 2 }))
    .map(() => pick(tc, clean, SAFE_NAMES, UNSAFE_NAMES));

  const program = pick(tc, clean, [...ISOLATE_PROGRAMS], CONTAINER_PROGRAMS);
  const args = tc.draw(gs.arrays(gs.just(0), { maxSize: 3 })).map(() => drawArgument(tc, clean));

  return {
    words: [
      ...names.map((name) => `${name}=${tc.draw(unquotedText)}`),
      quoted(tc, program),
      ...args.map((arg) => arg.text),
    ],
    isolate:
      ISOLATE_PROGRAMS.has(program) &&
      names.every((name) => SAFE_NAMES.includes(name)) &&
      args.every((arg) => !arg.flag),
    outside: args.some((arg) => arg.path !== undefined && isSystemPath(arg.path)),
  };
}

function drawSegments(tc: hegel.TestCase, clean: boolean): readonly Segment[] {
  return tc
    .draw(gs.arrays(gs.just(0), { minSize: 1, maxSize: 3 }))
    .map(() => drawSegment(tc, clean));
}

function commandOf(tc: hegel.TestCase, segments: readonly (readonly string[])[]): string {
  return segments
    .map((words) => words.join(tc.draw(gs.sampledFrom([" ", "  ", "\t"]))))
    .reduce((command, text) => `${command}${tc.draw(gs.sampledFrom(SEPARATORS))}${text}`);
}

test("a command goes to the isolate exactly when every segment can run there and no word names a system path", () => {
  hegel.test(
    (tc) => {
      const segments = drawSegments(tc, false);

      const command = commandOf(
        tc,
        segments.map((segment) => segment.words),
      );

      const requested = tc.draw(gs.sampledFrom([undefined, "isolate", "container"] as const));

      const isolate =
        requested !== "container" &&
        segments.every((segment) => segment.isolate && !segment.outside);

      expect(routedBackend(command, requested)).toBe(isolate ? "isolate" : "container");
    },
    { testCases: 400 },
  );
});

test("a construct the router cannot read sends a command that would run in the isolate to the container", () => {
  hegel.test(
    (tc) => {
      const segments = drawSegments(tc, true);

      expect(segments.every((segment) => segment.isolate && !segment.outside)).toBe(true);

      const words = segments.map((segment) => [...segment.words]);
      const construct = tc.draw(gs.sampledFrom([...UNREADABLE, ...UNTERMINATED]));

      if (UNTERMINATED.includes(construct)) {
        words.at(-1)?.push(construct);
      } else {
        const target = tc.draw(gs.sampledFrom(words));

        target.splice(tc.draw(gs.integers({ minValue: 0, maxValue: target.length })), 0, construct);
      }

      const command = commandOf(tc, words);

      expect(routedBackend(command, tc.draw(gs.sampledFrom([undefined, "isolate"] as const)))).toBe(
        "container",
      );
    },
    { testCases: 200 },
  );
});

const ROUTES: ReadonlyArray<readonly [string, "isolate" | "container" | undefined, string]> = [
  ["", undefined, "container"],
  ["FOO=1", undefined, "container"],
  ["for f in *; do cat $f; done", undefined, "container"],
  ["git status --short", undefined, "isolate"],
  ["git push origin main", undefined, "isolate"],
  ["curl https://github.com/owner/repo", undefined, "isolate"],
  ["printf 'h\u00C9llo \u2713\\n' > /tmp/u.txt && cat /tmp/u.txt", undefined, "container"],
  ["echo >/bin", undefined, "container"],
  ["echo hi>/tmp/x", undefined, "container"],
  [">ls node", undefined, "container"],
  ["cat </etc/hosts", undefined, "container"],
  ["echo hi > /dev/null", undefined, "isolate"],
  ["curl -s -o /dev/null -w '%{http_code}' https://github.com/owner/repo", undefined, "isolate"],
  ["echo hi > /dev/stdout", undefined, "container"],
  ["grep 'a|b; c' file > out.txt 2>&1", undefined, "isolate"],
  ["ls", "container", "container"],
  ["node -e 1 | cat", "isolate", "container"],
];

test.each(ROUTES)("%j (%s) goes to %s", (command, requested, expected) => {
  expect(routedBackend(command, requested)).toBe(expected);
});
