// oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type --
// Runtime guards and envelope parsing for values that arrive from the project RPC target. A real
// Workers RPC hop, or a target this adapter does not fully trust, can hand back anything at all —
// these functions narrow that `unknown` value to a known shape or report it as malformed, rather
// than assuming its declared TypeScript type still describes what actually arrived.

import type { ProjectFileInfo, ProjectFileKind } from "../../workspace/project/protocol.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isNull(value: unknown): value is null {
  return value === null;
}

export function isUint8Array(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array;
}

export type EnvelopeFailure = { readonly code: string; readonly path?: string };

export type ParsedEnvelope<T> =
  | { readonly kind: "ok"; readonly value: T }
  | { readonly kind: "failure"; readonly error: EnvelopeFailure }
  | { readonly kind: "malformed" };

/** Parses a raw RPC return value into one of `ProjectResult<T>`'s two shapes, or `"malformed"`. */
export function parseEnvelope<T>(
  raw: unknown,
  isValue: (value: unknown) => value is T,
): ParsedEnvelope<T> {
  if (!isRecord(raw) || typeof raw.ok !== "boolean") return { kind: "malformed" };

  if (raw.ok) {
    return isValue(raw.value) ? { kind: "ok", value: raw.value } : { kind: "malformed" };
  }

  if (!isRecord(raw.error) || typeof raw.error.code !== "string") return { kind: "malformed" };
  const { code } = raw.error;

  return typeof raw.error.path === "string"
    ? { kind: "failure", error: { code, path: raw.error.path } }
    : { kind: "failure", error: { code } };
}

const PROJECT_FILE_KINDS: ReadonlySet<string> = new Set(["file", "directory", "symlink"]);

function isProjectFileKind(value: unknown): value is ProjectFileKind {
  return typeof value === "string" && PROJECT_FILE_KINDS.has(value);
}

export function isProjectFileInfo(value: unknown): value is ProjectFileInfo {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    typeof value.path === "string" &&
    isProjectFileKind(value.kind) &&
    typeof value.size === "number" &&
    typeof value.mtimeMs === "number"
  );
}

export type ParsedCanonicalPath =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly error: EnvelopeFailure };

function isParsedCanonicalPath(value: unknown): value is ParsedCanonicalPath {
  if (!isRecord(value) || typeof value.ok !== "boolean") return false;

  if (value.ok) return typeof value.value === "string";

  return isRecord(value.error) && typeof value.error.code === "string";
}

/** `lstat`'s value: a `ProjectFileInfo` plus its own nested `ProjectResult<string>` canonical path. */
export type ProjectLstatValue = ProjectFileInfo & { readonly canonicalPath: ParsedCanonicalPath };

export function isProjectLstatValue(value: unknown): value is ProjectLstatValue {
  return (
    isProjectFileInfo(value) &&
    "canonicalPath" in value &&
    isParsedCanonicalPath(value.canonicalPath)
  );
}

export interface StartExecValue {
  readonly operationId: string;
  /** Newline-delimited UTF-8 JSON frames: the only shape Workers RPC can carry across the hop. */
  readonly events: ReadableStream<Uint8Array>;
}

function looksLikeReadableStream(value: unknown): value is ReadableStream<unknown> {
  return isRecord(value) && typeof value.getReader === "function";
}

export function isStartExecValue(value: unknown): value is StartExecValue {
  return (
    isRecord(value) &&
    typeof value.operationId === "string" &&
    looksLikeReadableStream(value.events)
  );
}

export type ParsedExecEvent =
  | { readonly kind: "stdout"; readonly data: unknown }
  | { readonly kind: "stderr"; readonly data: unknown }
  | { readonly kind: "terminal"; readonly outcome: "exited"; readonly exitCode: number }
  | { readonly kind: "terminal"; readonly outcome: "killed" | "timed-out" | "failed" };

/** Parses one raw exec-stream event, or `undefined` if its shape does not match a known event. */
export function parseExecEvent(value: unknown): ParsedExecEvent | undefined {
  if (!isRecord(value) || typeof value.kind !== "string") return undefined;

  if (value.kind === "stdout" || value.kind === "stderr")
    return { kind: value.kind, data: value.data };

  if (value.kind !== "terminal" || typeof value.outcome !== "string") return undefined;

  if (value.outcome === "exited") {
    return typeof value.exitCode === "number"
      ? { kind: "terminal", outcome: "exited", exitCode: value.exitCode }
      : undefined;
  }

  if (value.outcome === "killed" || value.outcome === "timed-out" || value.outcome === "failed") {
    return { kind: "terminal", outcome: value.outcome };
  }

  return undefined;
}
