import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { expect, test } from "vitest";
import { commandProgram } from "../../../src/workspace/project/exec-program.js";

const PROGRAMS = ["ls", "deploy.sh", "node", "grep", "python3", "git"];

const SECRETS = ["ghp_secret", "'token ghp_secret'", "--key=hunter2", '"a b"', "/home/me/x"];

const GIT_OPTIONS = ["-C repo", "-c user.name=x", "--no-pager", "--git-dir .git"];

const GIT_SUBCOMMANDS = ["status", "commit", "push", "rebase", "log"];

const SEPARATORS = [" && ", "; ", " | ", "\n"];

interface Segment {
  readonly text: string;
  readonly label: string | undefined;
}

function drawSegment(tc: hegel.TestCase): Segment {
  const assignment = tc.draw(gs.sampledFrom(["", "GH_TOKEN=abc ", "A=1 B=2 "]));
  const directory = tc.draw(gs.sampledFrom(["", "./", "/usr/bin/", "./scripts/"]));
  const program = tc.draw(gs.sampledFrom(PROGRAMS));
  const options = program === "git" ? tc.draw(gs.arrays(gs.sampledFrom(GIT_OPTIONS))) : [];

  const subcommand =
    program === "git" ? tc.draw(gs.optional(gs.sampledFrom(GIT_SUBCOMMANDS))) : null;

  const bare = program === "git" && subcommand === null;
  const args = bare ? [] : tc.draw(gs.arrays(gs.sampledFrom(SECRETS), { maxSize: 3 }));

  return {
    text: [`${assignment}${directory}${program}`, ...options, subcommand ?? "", ...args].join(" "),
    label: program === "git" && subcommand !== null ? `git ${subcommand}` : program,
  };
}

test("an exec is logged as its program name, or git and its subcommand when any segment runs git, and never with its arguments", () => {
  hegel.test(
    (tc) => {
      const segments = tc
        .draw(gs.arrays(gs.just(0), { minSize: 1, maxSize: 3 }))
        .map(() => drawSegment(tc));

      const command = segments
        .map((segment) => segment.text)
        .reduce((joined, text) => `${joined}${tc.draw(gs.sampledFrom(SEPARATORS))}${text}`);

      const git = segments.find((segment) => segment.label?.startsWith("git") === true);

      expect(commandProgram(command)).toBe((git ?? segments[0])?.label);
    },
    { testCases: 300 },
  );
});

test.each([
  ["git commit -m \"$(cat <<'EOF'\nfix: ship it\nEOF\n)\"", "git commit"],
  ["echo 'git push --force'", "echo"],
  ['"$HOME/bin/tool" run', "other"],
  ["git 'odd sub'", "git other"],
  ["   ", null],
])("%j is logged as %j", (command, program) => {
  expect(commandProgram(command)).toBe(program);
});
