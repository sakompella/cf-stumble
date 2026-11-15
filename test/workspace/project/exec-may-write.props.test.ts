import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { expect, test } from "vitest";
import { commandMayWrite } from "../../../src/workspace/project/exec-routing.js";

const READERS = ["cat", "grep", "seq", "ls", "head", "wc", "sort", "echo", "find", "sed"];

const WRITERS = [
  "chmod",
  "cp",
  "gunzip",
  "gzip",
  "ln",
  "mkdir",
  "mv",
  "rm",
  "rmdir",
  "split",
  "tar",
  "tee",
  "touch",
];

const READ_FLAGS = ["-n", "-e", "--expression", "-r", "-E", "--quiet", "-s"];

const IN_PLACE_FLAGS = ["-i", "-nri", "-i.bak", "--in-place", "--in-place=bak"];

const WRITE_REDIRECTS = [">", ">>", ">&", "2>", "1> "];

const UNREADABLE = ["$(id)", "`id`", "(", "{", "a\\ b", "<<EOF", "'open"];

const SEPARATORS = [" | ", ";", " && ", " || ", " & ", "\n"];

const word = gs.text({ alphabet: "abxyz019._+:,@%=*/", minSize: 1, maxSize: 4 });

interface Segment {
  readonly text: string;
  readonly writes: boolean;
}

function drawArgument(tc: hegel.TestCase, program: string): Segment {
  const kind = tc.draw(gs.sampledFrom(["word", "flag", "redirect", "input", "flag"] as const));

  if (kind === "word") return { text: tc.draw(word), writes: false };

  if (kind === "input") return { text: `< ${tc.draw(word)}`, writes: false };

  if (kind === "redirect") {
    return { text: `${tc.draw(gs.sampledFrom(WRITE_REDIRECTS))}${tc.draw(word)}`, writes: true };
  }

  const inPlace = tc.draw(gs.booleans());
  const flag = tc.draw(gs.sampledFrom(inPlace ? IN_PLACE_FLAGS : READ_FLAGS));

  return { text: flag, writes: inPlace && program === "sed" };
}

function drawSegment(tc: hegel.TestCase): Segment {
  const unsafe = tc.draw(gs.integers({ minValue: 0, maxValue: 5 })) === 0;

  const assignment = tc.draw(
    gs.sampledFrom(unsafe ? ["PATH=x ", "LD_PRELOAD=x "] : ["", "FOO=1 "]),
  );

  const writer = tc.draw(gs.integers({ minValue: 0, maxValue: 2 })) === 0;
  const program = tc.draw(gs.sampledFrom(writer ? WRITERS : READERS));
  const quote = tc.draw(gs.sampledFrom(["", "'", '"']));

  const args = tc.draw(gs.arrays(gs.just(0), { maxSize: 3 })).map(() => drawArgument(tc, program));

  return {
    text: [`${assignment}${quote}${program}${quote}`, ...args.map((arg) => arg.text)].join(" "),
    writes: unsafe || writer || args.some((arg) => arg.writes),
  };
}

test("a command may write exactly when a segment runs a writing program, edits in place, redirects output, sets an unsafe variable or cannot be read", () => {
  hegel.test(
    (tc) => {
      const segments = tc
        .draw(gs.arrays(gs.just(0), { minSize: 1, maxSize: 3 }))
        .map(() => drawSegment(tc));

      const unreadable = tc.draw(gs.integers({ minValue: 0, maxValue: 5 })) === 0;
      const construct = unreadable ? ` ${tc.draw(gs.sampledFrom(UNREADABLE))}` : "";

      const command = segments
        .map((segment) => segment.text)
        .reduce((joined, text) => `${joined}${tc.draw(gs.sampledFrom(SEPARATORS))}${text}`);

      expect(commandMayWrite(`${command}${construct}`)).toBe(
        unreadable || segments.some((segment) => segment.writes),
      );
    },
    { testCases: 1_000 },
  );
});

test("each documented program writes or reads on its own, and sed edits in place only with an in-place flag", () => {
  for (const program of WRITERS) {
    expect(commandMayWrite(`${program} a b`), program).toBe(true);
  }

  for (const program of READERS) {
    expect(commandMayWrite(`${program} a b`), program).toBe(false);
  }

  for (const flag of IN_PLACE_FLAGS) {
    expect(commandMayWrite(`sed ${flag} s/a/b/ file`), flag).toBe(true);
  }

  for (const flag of READ_FLAGS) {
    expect(commandMayWrite(`sed ${flag} s/a/b/ file`), flag).toBe(false);
  }
});
