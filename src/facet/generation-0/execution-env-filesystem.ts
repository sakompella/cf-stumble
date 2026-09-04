import { FileError } from "@cf-stumble/pi";
import type { FileInfo, Result } from "@cf-stumble/pi";
import type { ProjectRpcTargetContract } from "../../workspace/project/protocol.js";
import {
  fromAddressedPath,
  mapProjectError,
  resolveAbsolute,
  toAddressedPath,
} from "./execution-env-paths.js";
import { isNull, isProjectLstatValue, isUint8Array, parseEnvelope } from "./execution-env-rpc.js";
import type { ProjectLstatValue } from "./execution-env-rpc.js";

/**
 * The read/write/stat file operations `createFacetExecutionEnv` needs from the project RPC target.
 * Every function here takes `cwd` and `target` as plain arguments rather than closing over them, so
 * `createFacetExecutionEnv` stays a thin composition and nothing here can hold the target longer
 * than one call.
 */
type FsTarget = Pick<ProjectRpcTargetContract, "lstat" | "readFile" | "writeFile">;

const TEMP_DIR_ADDRESSED = "/.cf-stumble/tmp";
const MAX_TEMP_FILE_ATTEMPTS = 16;

/** The one failure shape every unsupported or already-aborted method resolves to. Named (rather
 * than an inline anonymous object type) so it composes into `Result<T, FileError>` for any `T`. */
export type FileFailure = Readonly<{ ok: false; error: FileError }>;

export function abortedError(path?: string): FileFailure {
  return {
    ok: false,
    error: new FileError("aborted", "the abort signal was already aborted", path),
  };
}

export function unsupportedError(name: string, path?: string): FileFailure {
  return {
    ok: false,
    error: new FileError(
      "not_supported",
      `${name} is not supported by the facet execution environment`,
      path,
    ),
  };
}

function isAborted(abortSignal: AbortSignal | undefined): boolean {
  return abortSignal !== undefined && abortSignal.aborted;
}

function translatePath(
  cwd: string,
  path: string,
): Result<{ absolute: string; addressed: string }, FileError> {
  const resolved = resolveAbsolute(cwd, path);
  if (!resolved.ok) return resolved;
  return {
    ok: true,
    value: { absolute: resolved.value, addressed: toAddressedPath(resolved.value) },
  };
}

export function absolutePathVia(
  cwd: string,
  path: string,
  abortSignal: AbortSignal | undefined,
): Result<string, FileError> {
  if (isAborted(abortSignal)) return abortedError(path);
  return resolveAbsolute(cwd, path);
}

export async function readBinaryFileVia(
  cwd: string,
  target: FsTarget,
  path: string,
  abortSignal: AbortSignal | undefined,
): Promise<Result<Uint8Array, FileError>> {
  if (isAborted(abortSignal)) return abortedError(path);
  const translated = translatePath(cwd, path);
  if (!translated.ok) return translated;

  let raw: unknown;
  try {
    raw = await target.readFile(translated.value.addressed);
  } catch {
    return { ok: false, error: new FileError("unknown", "readFile RPC rejected", path) };
  }
  const envelope = parseEnvelope(raw, isUint8Array);
  if (envelope.kind === "malformed")
    return { ok: false, error: new FileError("unknown", "malformed readFile response", path) };
  if (envelope.kind === "failure")
    return { ok: false, error: mapProjectError(envelope.error.code, path) };
  return { ok: true, value: envelope.value };
}

export async function readTextFileVia(
  cwd: string,
  target: FsTarget,
  path: string,
  abortSignal: AbortSignal | undefined,
): Promise<Result<string, FileError>> {
  const bytes = await readBinaryFileVia(cwd, target, path, abortSignal);
  if (!bytes.ok) return bytes;
  return { ok: true, value: new TextDecoder().decode(bytes.value) };
}

export async function writeVia(
  cwd: string,
  target: FsTarget,
  path: string,
  content: string | Uint8Array,
  mode: "overwrite" | "append",
  abortSignal: AbortSignal | undefined,
): Promise<Result<void, FileError>> {
  if (isAborted(abortSignal)) return abortedError(path);
  const translated = translatePath(cwd, path);
  if (!translated.ok) return translated;
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- `content` is Pi's own union parameter, not an untrusted boundary value; this distinguishes its two legal shapes.
  const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;

  let raw: unknown;
  try {
    raw = await target.writeFile(translated.value.addressed, bytes, mode);
  } catch {
    return { ok: false, error: new FileError("unknown", "writeFile RPC rejected", path) };
  }
  const envelope = parseEnvelope(raw, isNull);
  if (envelope.kind === "malformed")
    return { ok: false, error: new FileError("unknown", "malformed writeFile response", path) };
  if (envelope.kind === "failure")
    return { ok: false, error: mapProjectError(envelope.error.code, path) };
  return { ok: true, value: undefined };
}

type LstatOutcome = Result<{ absolute: string; value: ProjectLstatValue }, FileError>;

async function lstatVia(
  cwd: string,
  target: FsTarget,
  path: string,
  abortSignal: AbortSignal | undefined,
): Promise<LstatOutcome> {
  if (isAborted(abortSignal)) return abortedError(path);
  const translated = translatePath(cwd, path);
  if (!translated.ok) return translated;

  let raw: unknown;
  try {
    raw = await target.lstat(translated.value.addressed);
  } catch {
    return { ok: false, error: new FileError("unknown", "lstat RPC rejected", path) };
  }
  const envelope = parseEnvelope(raw, isProjectLstatValue);
  if (envelope.kind === "malformed")
    return { ok: false, error: new FileError("unknown", "malformed lstat response", path) };
  if (envelope.kind === "failure")
    return { ok: false, error: mapProjectError(envelope.error.code, path) };
  return { ok: true, value: { absolute: translated.value.absolute, value: envelope.value } };
}

export async function fileInfoVia(
  cwd: string,
  target: FsTarget,
  path: string,
  abortSignal: AbortSignal | undefined,
): Promise<Result<FileInfo, FileError>> {
  const stat = await lstatVia(cwd, target, path, abortSignal);
  if (!stat.ok) return stat;
  const { name, kind, size, mtimeMs } = stat.value.value;
  return { ok: true, value: { name, path: stat.value.absolute, kind, size, mtimeMs } };
}

export async function canonicalPathVia(
  cwd: string,
  target: FsTarget,
  path: string,
  abortSignal: AbortSignal | undefined,
): Promise<Result<string, FileError>> {
  const stat = await lstatVia(cwd, target, path, abortSignal);
  if (!stat.ok) return stat;
  const canonical = stat.value.value.canonicalPath;
  if (!canonical.ok) return { ok: false, error: mapProjectError(canonical.error.code, path) };
  return { ok: true, value: fromAddressedPath(canonical.value) };
}

export async function existsVia(
  cwd: string,
  target: FsTarget,
  path: string,
  abortSignal: AbortSignal | undefined,
): Promise<Result<boolean, FileError>> {
  const info = await fileInfoVia(cwd, target, path, abortSignal);
  if (info.ok) return { ok: true, value: true };
  if (info.error.code === "not_found") return { ok: true, value: false };
  return info;
}

function sanitizeBasenamePart(value: string | undefined, label: string): Result<string, FileError> {
  const part = value ?? "";
  if (part.includes("/") || part.includes("\0")) {
    return {
      ok: false,
      error: new FileError("invalid", `${label} must not contain "/" or a NUL byte`),
    };
  }
  return { ok: true, value: part };
}

export async function createTempFileVia(
  target: Pick<ProjectRpcTargetContract, "writeFile">,
  options: { prefix?: string; suffix?: string; abortSignal?: AbortSignal } | undefined,
): Promise<Result<string, FileError>> {
  if (isAborted(options?.abortSignal)) return abortedError();
  const prefix = sanitizeBasenamePart(options?.prefix, "prefix");
  if (!prefix.ok) return prefix;
  const suffix = sanitizeBasenamePart(options?.suffix, "suffix");
  if (!suffix.ok) return suffix;

  for (let attempt = 0; attempt < MAX_TEMP_FILE_ATTEMPTS; attempt++) {
    const name = `${prefix.value}${crypto.randomUUID().replaceAll("-", "")}${suffix.value}`;
    const addressed = `${TEMP_DIR_ADDRESSED}/${name}`;

    let raw: unknown;
    try {
      // oxlint-disable-next-line no-await-in-loop -- Each attempt must observe the previous failure before retrying with a new random name.
      raw = await target.writeFile(addressed, new Uint8Array(0), "create-exclusive");
    } catch {
      return { ok: false, error: new FileError("unknown", "writeFile RPC rejected") };
    }
    const envelope = parseEnvelope(raw, isNull);
    if (envelope.kind === "malformed")
      return { ok: false, error: new FileError("unknown", "malformed writeFile response") };
    if (envelope.kind === "ok") return { ok: true, value: fromAddressedPath(addressed) };
    if (envelope.error.code !== "already-exists")
      return { ok: false, error: mapProjectError(envelope.error.code) };
  }
  return {
    ok: false,
    error: new FileError("unknown", "could not allocate a unique temp file name after 16 attempts"),
  };
}
