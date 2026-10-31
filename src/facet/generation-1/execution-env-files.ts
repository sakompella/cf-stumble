import type { Context } from "@earendil-works/chord/context";
import { FileError, type FileInfo, type Result } from "@earendil-works/pi-durable/env";
import type { ProjectFileInfo, ProjectLstatInfo } from "../../workspace/project/protocol.js";
import {
  aborted,
  basename,
  capabilityCall,
  fromAddressed,
  fromProject,
  invalid,
  resolveInWorkspace,
  type ComputerWorkspace,
  type WorkspacePath,
} from "./execution-env-paths.js";

export const TEMP_DIRECTORY = "/.cf-stumble/tmp";

type Opened = Result<WorkspacePath, FileError>;

export function open(workspace: ComputerWorkspace, path: string, context: Context): Opened {
  if (context.abortSignal?.aborted === true) return aborted(path);

  return resolveInWorkspace(workspace.cwd, path);
}

export function fileInfoOf(path: WorkspacePath, info: ProjectFileInfo): FileInfo {
  const { kind, size, mtimeMs } = info;

  return { name: basename(path.absolute), path: path.absolute, kind, size, mtimeMs };
}

export function lstat(
  workspace: ComputerWorkspace,
  path: WorkspacePath,
): Promise<Result<ProjectLstatInfo, FileError>> {
  return capabilityCall(path.absolute, () => workspace.target.lstat(path.addressed));
}

export async function statFollowing(
  workspace: ComputerWorkspace,
  path: WorkspacePath,
): Promise<
  Result<{ info: ProjectFileInfo; canonical: WorkspacePath; linked: boolean }, FileError>
> {
  const stat = await lstat(workspace, path);

  if (!stat.ok) return stat;

  const resolved = fromProject(stat.value.canonicalPath, path.absolute);

  if (!resolved.ok) return resolved;

  const canonical = fromAddressed(resolved.value);

  if (stat.value.kind !== "symlink") {
    return { ok: true, value: { info: stat.value, canonical, linked: false } };
  }

  const target = await lstat(workspace, canonical);

  return target.ok ? { ok: true, value: { info: target.value, canonical, linked: true } } : target;
}

export function readBytes(
  workspace: ComputerWorkspace,
  path: string,
  context: Context,
): Promise<Result<Uint8Array, FileError>> {
  const opened = open(workspace, path, context);

  if (!opened.ok) return Promise.resolve(opened);

  return capabilityCall(opened.value.absolute, () =>
    workspace.target.readFile(opened.value.addressed),
  );
}

export function absolutePath(
  workspace: ComputerWorkspace,
  path: string,
  context: Context,
): Promise<Result<string, FileError>> {
  const opened = open(workspace, path, context);

  return Promise.resolve(opened.ok ? { ok: true, value: opened.value.absolute } : opened);
}

export async function readTextFile(
  workspace: ComputerWorkspace,
  path: string,
  context: Context,
): Promise<Result<string, FileError>> {
  const bytes = await readBytes(workspace, path, context);

  return bytes.ok ? { ok: true, value: decodeText(bytes.value) } : bytes;
}

function decodeText(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(bytes);
}

export async function writeBytes(
  workspace: ComputerWorkspace,
  path: string,
  content: string | Uint8Array,
  mode: "overwrite" | "append",
  context: Context,
): Promise<Result<void, FileError>> {
  const opened = open(workspace, path, context);

  if (!opened.ok) return opened;

  const bytes = content instanceof Uint8Array ? content : new TextEncoder().encode(content);

  const written = await capabilityCall(opened.value.absolute, () =>
    workspace.target.writeFile(opened.value.addressed, bytes, mode),
  );

  return written.ok ? { ok: true, value: undefined } : written;
}

export async function fileInfo(
  workspace: ComputerWorkspace,
  path: string,
  context: Context,
): Promise<Result<FileInfo, FileError>> {
  const opened = open(workspace, path, context);

  if (!opened.ok) return opened;

  const stat = await lstat(workspace, opened.value);

  return stat.ok ? { ok: true, value: fileInfoOf(opened.value, stat.value) } : stat;
}

export async function exists(
  workspace: ComputerWorkspace,
  path: string,
  context: Context,
): Promise<Result<boolean, FileError>> {
  const info = await fileInfo(workspace, path, context);

  if (info.ok) return { ok: true, value: true };

  return info.error.code === "not_found" ? { ok: true, value: false } : info;
}

export async function canonicalPath(
  workspace: ComputerWorkspace,
  path: string,
  context: Context,
): Promise<Result<string, FileError>> {
  const opened = open(workspace, path, context);

  if (!opened.ok) return opened;

  const stat = await lstat(workspace, opened.value);

  if (!stat.ok) return stat;

  const canonical = fromProject(stat.value.canonicalPath, opened.value.absolute);

  return canonical.ok ? { ok: true, value: fromAddressed(canonical.value).absolute } : canonical;
}

export async function listDirectory(
  workspace: ComputerWorkspace,
  path: WorkspacePath,
): Promise<Result<FileInfo[], FileError>> {
  const listed = await capabilityCall(path.absolute, () =>
    workspace.target.listFiles(path.addressed),
  );

  if (!listed.ok) return listed;

  if (listed.value.truncated) {
    return {
      ok: false,
      error: new FileError(
        "unknown",
        "the directory has more entries than Computer lists",
        path.absolute,
      ),
    };
  }

  return {
    ok: true,
    value: listed.value.entries.map((entry) => fileInfoOf(fromAddressed(entry.path), entry)),
  };
}

export function listDir(
  workspace: ComputerWorkspace,
  path: string,
  context: Context,
): Promise<Result<FileInfo[], FileError>> {
  const opened = open(workspace, path, context);

  if (!opened.ok) return Promise.resolve(opened);

  return listDirectory(workspace, opened.value);
}

export async function flushFile(
  workspace: ComputerWorkspace,
  path: string,
  context: Context,
): Promise<Result<void, FileError>> {
  const opened = open(workspace, path, context);

  if (!opened.ok) return opened;

  const stat = await statFollowing(workspace, opened.value);

  if (!stat.ok) return stat;

  if (stat.value.info.kind === "directory") {
    return {
      ok: false,
      error: new FileError("is_directory", "Is a directory", opened.value.absolute),
    };
  }

  return { ok: true, value: undefined };
}

export async function truncateFile(
  workspace: ComputerWorkspace,
  path: string,
  size: number,
  context: Context,
): Promise<Result<void, FileError>> {
  if (!Number.isSafeInteger(size) || size < 0) {
    return invalid("File size must be a non-negative safe integer", path);
  }

  const bytes = await readBytes(workspace, path, context);

  if (!bytes.ok) return bytes;

  const resized = new Uint8Array(size);
  resized.set(bytes.value.subarray(0, size));

  return writeBytes(workspace, path, resized, "overwrite", context);
}

function namePart(value: string | undefined, label: string): Result<string, FileError> {
  const part = value ?? "";

  if (part.includes("/") || part.includes("\0"))
    return invalid(`${label} must not contain "/" or NUL`);

  return { ok: true, value: part };
}

export function uniqueTempPath(
  prefix: string | undefined,
  suffix?: string,
): Result<WorkspacePath, FileError> {
  const before = namePart(prefix, "prefix");

  if (!before.ok) return before;

  const after = namePart(suffix, "suffix");

  if (!after.ok) return after;

  const name = `${before.value}${crypto.randomUUID().replaceAll("-", "")}${after.value}`;

  return { ok: true, value: fromAddressed(`${TEMP_DIRECTORY}/${name}`) };
}

export async function createTempFile(
  workspace: ComputerWorkspace,
  options: { prefix?: string; suffix?: string } | undefined,
  context: Context,
): Promise<Result<string, FileError>> {
  if (context.abortSignal?.aborted === true) return aborted();

  const path = uniqueTempPath(options?.prefix, options?.suffix);

  if (!path.ok) return path;

  const created = await capabilityCall(path.value.absolute, () =>
    workspace.target.writeFile(path.value.addressed, new Uint8Array(0), "create-exclusive"),
  );

  return created.ok ? { ok: true, value: path.value.absolute } : created;
}
