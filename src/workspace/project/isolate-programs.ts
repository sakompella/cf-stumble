import { ISOLATE_COMMAND_NAMES } from "./isolate-commands.generated.js";

const RUNS_OTHER_PROGRAMS = ["xargs", "env", "bash", "sh", "time", "timeout", "sqlite3"];

const NOT_IN_ISOLATE = new Set([...RUNS_OTHER_PROGRAMS, "html-to-markdown"]);

const ISOLATE_SHELL_FEATURES = ["cd", "test", "git", "curl"];

export const ISOLATE_PROGRAMS: ReadonlySet<string> = new Set([
  ...ISOLATE_COMMAND_NAMES.filter((name) => !NOT_IN_ISOLATE.has(name)),
  ...ISOLATE_SHELL_FEATURES,
]);
