const SEGMENT_BREAKS = new Set([";", "|", "&", "\n", "(", ")", "{", "}", "`"]);

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/u;

const PROGRAM_NAME = /^[A-Za-z0-9._+-]{1,40}$/u;

const GIT_SUBCOMMAND = /^[a-z][a-z0-9-]{0,39}$/u;

const GIT_OPTIONS_WITH_VALUE = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--config-env",
]);

function segments(command: string): readonly (readonly string[])[] {
  const all: string[][] = [[]];
  let word = "";
  let quote: string | undefined;
  let quoted = false;

  const endWord = () => {
    if (word !== "" || quoted) all.at(-1)?.push(quoted ? "" : word);
    word = "";
    quoted = false;
  };

  for (const char of command) {
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
    } else if (char === "'" || char === '"') {
      quote = char;
      quoted = true;
    } else if (SEGMENT_BREAKS.has(char)) {
      endWord();
      all.push([]);
    } else if (char === " " || char === "\t") {
      endWord();
    } else {
      word += char;
    }
  }

  endWord();

  return all.flatMap((words) => {
    const program = words.findIndex((each) => !ASSIGNMENT.test(each));

    return program === -1 ? [] : [words.slice(program)];
  });
}

function programName(word: string): string {
  const name = word.slice(word.lastIndexOf("/") + 1);

  return PROGRAM_NAME.test(name) ? name : "other";
}

function gitSubcommand(args: readonly string[]): string | undefined {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? "";

    if (GIT_OPTIONS_WITH_VALUE.has(arg)) index++;
    else if (!arg.startsWith("-")) return GIT_SUBCOMMAND.test(arg) ? arg : "other";
  }

  return undefined;
}

export function commandProgram(command: string): string | null {
  const found = segments(command);
  const git = found.find((words) => programName(words[0] ?? "") === "git");

  if (git !== undefined) {
    const subcommand = gitSubcommand(git.slice(1));

    return subcommand === undefined ? "git" : `git ${subcommand}`;
  }

  const [first] = found;

  return first === undefined ? null : programName(first[0] ?? "");
}
