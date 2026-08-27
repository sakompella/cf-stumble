/**
 * Every way a primitive can fail, as one tagged error per condition.
 *
 * These replace three separately-invented result unions (`WorkspacePathValidation`,
 * `EditDecision`, `PrimitiveFailure`). The point of the change is exhaustiveness: a `switch` over
 * a `kind` field compiles fine when a variant is added and silently falls through, whereas
 * `error.match({ ... })` over this union does not compile until the new variant is handled. The
 * one place that matters is `failedTurn` in `src/validation/preflight-results.ts`, which decides
 * whether a failure is the harness's fault or the candidate's.
 *
 * `message` is developer-facing and carries the detail needed to debug. User-facing text is built
 * at the presentation boundary, not read off these errors.
 */

import { TaggedError } from "better-result";
import type { PrimitiveKind } from "./primitives.js";

/** Why a string is not a usable workspace-relative path. */
export type WorkspacePathRejection =
  | "empty"
  | "absolute"
  | "nul-byte"
  | "backslash"
  | "path-traversal"
  | "dot-segment"
  | "empty-segment";

export class InvalidWorkspacePathError extends TaggedError("InvalidWorkspacePathError")<{
  path: string;
  rejection: WorkspacePathRejection;
  message: string;
}> {
  constructor(args: { path: string; rejection: WorkspacePathRejection }) {
    super({
      ...args,
      message: `invalid workspace path (${args.rejection}): ${JSON.stringify(args.path)}`,
    });
  }
}

/**
 * A `Workspace` method threw. The workspace is injected infrastructure, so this is the harness
 * failing rather than the agent misusing it, and preflight treats it as inconclusive.
 */
export class WorkspaceOperationError extends TaggedError("WorkspaceOperationError")<{
  operation: PrimitiveKind;
  detail: string;
  message: string;
  cause: unknown;
}> {
  constructor(args: { operation: PrimitiveKind; cause: unknown }) {
    const detail = args.cause instanceof Error ? args.cause.message : String(args.cause);
    super({
      ...args,
      detail,
      message: `workspace error during ${args.operation}: ${detail}`,
    });
  }
}

export class WorkspaceFileNotFoundError extends TaggedError("WorkspaceFileNotFoundError")<{
  path: string;
  message: string;
}> {
  constructor(args: { path: string }) {
    super({ ...args, message: `file ${JSON.stringify(args.path)} was not found` });
  }
}

/** The primitives only read and write text; a binary file is a request they cannot satisfy. */
export class BinaryFileError extends TaggedError("BinaryFileError")<{
  path: string;
  message: string;
}> {
  constructor(args: { path: string }) {
    super({ ...args, message: `file ${JSON.stringify(args.path)} is binary` });
  }
}

export class EmptyEditSearchError extends TaggedError("EmptyEditSearchError")<{
  path: string;
  message: string;
}> {
  constructor(args: { path: string }) {
    super({
      ...args,
      message: `edit of ${JSON.stringify(args.path)} has empty search text, which would match everywhere`,
    });
  }
}

export class EditNoMatchError extends TaggedError("EditNoMatchError")<{
  path: string;
  oldText: string;
  message: string;
}> {
  constructor(args: { path: string; oldText: string }) {
    super({
      ...args,
      message: `edit of ${JSON.stringify(args.path)} found no match for its search text`,
    });
  }
}

/** An edit must identify exactly one site, so more than one match is a rejection, not a choice. */
export class EditAmbiguousMatchError extends TaggedError("EditAmbiguousMatchError")<{
  path: string;
  oldText: string;
  occurrences: number;
  message: string;
}> {
  constructor(args: { path: string; oldText: string; occurrences: number }) {
    super({
      ...args,
      message: `edit of ${JSON.stringify(args.path)} matched ${args.occurrences} sites; it must match exactly one`,
    });
  }
}

/**
 * The command hit its deadline. Whatever it printed before that is kept, because a timeout is
 * often diagnosed from the partial output.
 */
export class CommandTimeoutError extends TaggedError("CommandTimeoutError")<{
  command: string;
  timeoutMs: number;
  stdout: string;
  stderr: string;
  message: string;
}> {
  constructor(args: { command: string; timeoutMs: number; stdout: string; stderr: string }) {
    super({ ...args, message: `workspace command timed out after ${args.timeoutMs}ms` });
  }
}

export class InvalidCommandTimeoutError extends TaggedError("InvalidCommandTimeoutError")<{
  timeoutMs: number;
  message: string;
}> {
  constructor(args: { timeoutMs: number }) {
    super({
      ...args,
      message: `invalid bash timeout ${args.timeoutMs}; it must be a positive safe integer`,
    });
  }
}

export type EditMatchError = EmptyEditSearchError | EditNoMatchError | EditAmbiguousMatchError;

export type ReadPrimitiveError =
  | InvalidWorkspacePathError
  | WorkspaceOperationError
  | WorkspaceFileNotFoundError
  | BinaryFileError;

export type WritePrimitiveError = InvalidWorkspacePathError | WorkspaceOperationError;

export type EditPrimitiveError = ReadPrimitiveError | EditMatchError;

export type BashPrimitiveError =
  | WorkspaceOperationError
  | CommandTimeoutError
  | InvalidCommandTimeoutError;

/** Every failure `executePrimitive` can return. Adding a member breaks its consumers' `match`. */
export type PrimitiveError =
  | ReadPrimitiveError
  | WritePrimitiveError
  | EditPrimitiveError
  | BashPrimitiveError;
