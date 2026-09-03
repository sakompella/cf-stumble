import { isString } from "./plain-values.js";
import type { PiTool, PiToolCall } from "./workers-ai-adapter.js";

/**
 * The whole tool catalogue of Generation 0. Version 0 has one project, one workspace, and one
 * check command, so these six tools cover the file reads, edits, and command runs a coding turn
 * needs. Each one maps to exactly one operation the workspace capability already offers; the tools
 * describe no path root, no command line, and no credential.
 */
export const GENERATION_0_TOOLS: readonly PiTool[] = [
  {
    name: "read_file",
    description: "Read a UTF-8 text file in the project workspace.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Path relative to the project root." } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "write_file",
    description: "Create or replace a UTF-8 text file in the project workspace.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the project root." },
        content: { type: "string", description: "The complete new file contents." },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "edit_file",
    description:
      "Replace one exact occurrence of old_text with new_text in a file. The old text must appear exactly once.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the project root." },
        old_text: { type: "string", description: "The exact text to replace." },
        new_text: { type: "string", description: "The replacement text." },
      },
      required: ["path", "old_text", "new_text"],
      additionalProperties: false,
    },
  },
  {
    name: "list_files",
    description: "List the direct children of a directory in the project workspace.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Directory path relative to the project root. Use an empty string for the root.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "run_command",
    description:
      'Run one of the project commands the workspace allows, by name. The check command is named "check".',
    parameters: {
      type: "object",
      properties: { command: { type: "string", description: "The configured command name." } },
      required: ["command"],
      additionalProperties: false,
    },
  },
  {
    name: "git_diff",
    description: "Show the uncommitted changes in the project workspace.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
];

/**
 * What one tool call asks for. `planToolCall` decides this from the model's own arguments without
 * touching the workspace, so every rejection is a plain value a test can state.
 */
export type ToolPlan =
  | Readonly<{ kind: "read-file"; path: string }>
  | Readonly<{ kind: "write-file"; path: string; content: string }>
  | Readonly<{ kind: "list-files"; path: string }>
  | Readonly<{ kind: "run-command"; command: string }>
  | Readonly<{ kind: "git-diff" }>
  | Readonly<{ kind: "edit-file"; path: string; oldText: string; newText: string }>
  | Readonly<{ kind: "unknown-tool"; name: string }>
  | Readonly<{ kind: "invalid-arguments"; name: string; detail: string }>;

function invalid(name: string, detail: string): ToolPlan {
  return { kind: "invalid-arguments", name, detail };
}

function planEdit(parameters: PiToolCall["arguments"]): ToolPlan {
  const { path, old_text: oldText, new_text: newText } = parameters;
  if (!isString(path) || !isString(oldText) || !isString(newText)) {
    return invalid("edit_file", "path, old_text and new_text must all be strings");
  }
  if (oldText === "") {
    return invalid("edit_file", "old_text must not be empty");
  }

  return { kind: "edit-file", path, oldText, newText };
}

/** Decide what a model tool call asks for. Pure: the arguments are the only input. */
export function planToolCall(name: string, parameters: PiToolCall["arguments"]): ToolPlan {
  switch (name) {
    case "read_file": {
      const { path } = parameters;
      return isString(path) ? { kind: "read-file", path } : invalid(name, "path must be a string");
    }
    case "write_file": {
      const { path, content } = parameters;
      return isString(path) && isString(content)
        ? { kind: "write-file", path, content }
        : invalid(name, "path and content must both be strings");
    }
    case "edit_file":
      return planEdit(parameters);
    case "list_files": {
      const { path } = parameters;
      return isString(path) ? { kind: "list-files", path } : invalid(name, "path must be a string");
    }
    case "run_command": {
      const { command } = parameters;
      return isString(command)
        ? { kind: "run-command", command }
        : invalid(name, "command must be a string");
    }
    case "git_diff":
      return { kind: "git-diff" };
    default:
      return { kind: "unknown-tool", name };
  }
}

export type EditOutcome =
  | Readonly<{ ok: true; content: string }>
  | Readonly<{ ok: false; reason: "not-found" | "not-unique" }>;

/**
 * Replace one exact occurrence. A missing or repeated match is refused rather than guessed, so an
 * edit either changes the one place the model named or changes nothing.
 */
export function applyUniqueEdit(content: string, oldText: string, newText: string): EditOutcome {
  const occurrences = content.split(oldText).length - 1;
  if (occurrences === 0) return { ok: false, reason: "not-found" };
  if (occurrences > 1) return { ok: false, reason: "not-unique" };
  return { ok: true, content: content.replace(oldText, newText) };
}
