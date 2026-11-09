import { computerExecBackend, type ExecWorkspace } from "./computer-adapter.js";
import {
  CONTAINER_BACKEND_ID,
  ISOLATE_BACKEND_ID,
  type ContainerLifecycleState,
  type ExecBackend,
} from "./exec-backend.js";
import { isolateWithContainerFallback } from "./exec-fallback.js";
import { ISOLATE_PROGRAMS } from "./isolate-programs.js";
import type { ExecBackendChoice } from "./protocol.js";

const SEGMENT_BREAKS = new Set(["|", ";", "&", "\n"]);

const REFUSED_OUTSIDE_QUOTES = new Set(["(", ")", "{", "}", "`", "\\"]);

const EXECUTING_FIND_FLAGS = new Set(["-exec", "-execdir", "-ok", "-okdir", "-delete"]);

function firstWords(command: string): string[][] | undefined {
  const segments: string[][] = [];
  let words: string[] = [];
  let word = "";
  let quote: string | undefined;

  const endWord = () => {
    if (word !== "") words.push(word);
    word = "";
  };

  const endSegment = () => {
    endWord();

    if (words.length > 0) segments.push(words);
    words = [];
  };

  for (let index = 0; index < command.length; index++) {
    const char = command.charAt(index);
    const next = command.charAt(index + 1);

    if (quote === "'") {
      if (char === "'") quote = undefined;
      else word += char;
    } else if (char === "`" || (char === "$" && next === "(")) {
      return undefined;
    } else if (quote === '"') {
      if (char === '"') quote = undefined;
      else if (char === "\\") return undefined;
      else word += char;
    } else if (char === "'" || char === '"') {
      quote = char;
    } else if (REFUSED_OUTSIDE_QUOTES.has(char) || (char === "<" && next === "<")) {
      return undefined;
    } else if (char === "&" && command.charAt(index - 1) === ">") {
      word += char;
    } else if (SEGMENT_BREAKS.has(char)) {
      endSegment();
    } else if (char === " " || char === "\t") {
      endWord();
    } else {
      word += char;
    }
  }

  if (quote !== undefined) return undefined;
  endSegment();

  return segments;
}

const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=/u;

const UNSAFE_ASSIGNMENTS = /^(PATH|IFS|SHELL|ENV|BASH_ENV|LD_.*|DYLD_.*)$/u;

function withoutAssignments(words: readonly string[]): readonly string[] | undefined {
  const start = words.findIndex((word) => !ASSIGNMENT.test(word));
  const assigned = words.slice(0, start === -1 ? words.length : start);

  if (assigned.some((word) => UNSAFE_ASSIGNMENTS.test(ASSIGNMENT.exec(word)?.[1] ?? ""))) {
    return undefined;
  }

  return start === -1 ? [] : words.slice(start);
}

function segmentRunsInIsolate(words: readonly string[]): boolean {
  const [program = "", ...rest] = withoutAssignments(words) ?? [];

  if (!ISOLATE_PROGRAMS.has(program)) return false;

  return !rest.some((word) => EXECUTING_FIND_FLAGS.has(word));
}

const OUTSIDE_WORKSPACE_PREFIXES = [
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

const ISOLATE_VIRTUAL_DEV_PATHS = new Set(["/dev/null"]);

function referencesOutsidePath(word: string): boolean {
  if (!word.startsWith("/")) return false;

  if (ISOLATE_VIRTUAL_DEV_PATHS.has(word)) return false;

  return OUTSIDE_WORKSPACE_PREFIXES.some(
    (prefix) => word === prefix || word.startsWith(`${prefix}/`),
  );
}

function touchesPathOutsideWorkspace(command: string): boolean {
  const segments = firstWords(command);

  if (segments === undefined) return false;

  return segments.flat().some(referencesOutsidePath);
}

function isolateCanRun(command: string): boolean {
  const segments = firstWords(command);

  return segments !== undefined && segments.length > 0 && segments.every(segmentRunsInIsolate);
}

export function routedBackend(
  command: string,
  requested: ExecBackendChoice | undefined,
): ExecBackendChoice {
  if (requested === "container") return "container";

  if (touchesPathOutsideWorkspace(command)) return "container";

  return isolateCanRun(command) ? "isolate" : "container";
}

export function chosenExecBackend(
  workspace: ExecWorkspace,
  containerState: ContainerLifecycleState,
): ExecBackend {
  const container = computerExecBackend(workspace, CONTAINER_BACKEND_ID, containerState);
  const isolate = computerExecBackend(workspace, ISOLATE_BACKEND_ID, null);

  const isolateFirst = isolateWithContainerFallback(isolate, container);

  return {
    exec: (input) => {
      if (routedBackend(input.command, input.backend) !== "isolate") return container.exec(input);

      return (input.backend === undefined ? isolateFirst : isolate).exec(input);
    },
  };
}
