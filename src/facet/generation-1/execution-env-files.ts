import type { Context } from "@earendil-works/chord/context";
import type { FileError, FileInfo, Result } from "@earendil-works/pi-durable/env";
import { WORKSPACE_SPILL_DIRECTORY } from "../../workspace-layout.js";
import type { ProjectFileInfo, ProjectLstatInfo } from "../../workspace/project/protocol.js";
import {
  aborted,
  basename,
  capabilityCall,
  fromAddressed,
  fromProject,
  resolveInWorkspace,
  type ComputerWorkspace,
  type WorkspacePath,
} from "./execution-env-paths.js";

type Opened = Result<WorkspacePath, FileError>;

export function open(workspace: ComputerWorkspace, path: string, context: Context): Opened {
  if (context.abortSignal?.aborted === true) return aborted(path);

  return resolveInWorkspace(workspace.cwd, path);
}

export function fileInfoOf(path: WorkspacePath, info: ProjectFileInfo): FileInfo {
  const { kind, size, mtimeMs } = info;

  return { name: basename(path.absolute), path: path.absolute, kind, size, mtimeMs };
}

function lstat(
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

export async function createSpillFile(
  workspace: ComputerWorkspace,
): Promise<Result<string, FileError>> {
  const name = `pi-output-${crypto.randomUUID().replaceAll("-", "")}.log`;
  const opened = resolveInWorkspace(workspace.cwd, `${WORKSPACE_SPILL_DIRECTORY}/${name}`);

  if (!opened.ok) return opened;

  const created = await capabilityCall(opened.value.absolute, () =>
    workspace.target.writeFile(opened.value.addressed, new Uint8Array(0), "create-exclusive"),
  );

  return created.ok ? { ok: true, value: opened.value.absolute } : created;
}
