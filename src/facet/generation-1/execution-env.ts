import { FileError, type ExecutionEnv, type Result } from "@earendil-works/pi-durable/env";
import type { ProjectRpcTargetContract } from "../../workspace/project/protocol.js";
import { execInWorkspace, killAll, type RunningCommands } from "./execution-env-exec.js";
import {
  absolutePath,
  canonicalPath,
  createTempFile,
  exists,
  fileInfo,
  readTextFile,
  writeBytes,
} from "./execution-env-files.js";
import { joinPath, type ComputerWorkspace } from "./execution-env-paths.js";
import { createTempDir } from "./execution-env-posix.js";
import { openBinaryReader } from "./execution-env-readers.js";

const COMPUTER_ENV_ID = "cf-stumble:computer-workspace";

export interface ComputerEnvOptions {
  readonly cwd: string;
  readonly target: ProjectRpcTargetContract;
}

function unsupported(member: string): () => Promise<Result<never, FileError>> {
  const message = `the Computer workspace does not provide ${member}`;

  return () => Promise.resolve({ ok: false, error: new FileError("not_supported", message) });
}

export function createComputerEnv(options: ComputerEnvOptions): ExecutionEnv {
  const workspace: ComputerWorkspace = { cwd: options.cwd, target: options.target };
  const running: RunningCommands = new Set();

  return {
    id: COMPUTER_ENV_ID,
    cwd: workspace.cwd,
    absolutePath: (path, context) => absolutePath(workspace, path, context),
    joinPath: (parts) => joinPath(parts),
    readTextFile: (path, context) => readTextFile(workspace, path, context),
    openTextLineReader: unsupported("openTextLineReader"),
    readTextLines: unsupported("readTextLines"),
    readBinaryFile: unsupported("readBinaryFile"),
    openBinaryReader: (path, readerOptions, context) =>
      openBinaryReader(workspace, path, readerOptions?.noFollow === true, context),
    writeFile: (path, content, context) =>
      writeBytes(workspace, path, content, "overwrite", context),
    appendFile: unsupported("appendFile"),
    truncateFile: unsupported("truncateFile"),
    flushFile: unsupported("flushFile"),
    renameFile: unsupported("renameFile"),
    fileInfo: (path, context) => fileInfo(workspace, path, context),
    listDir: unsupported("listDir"),
    openDirReader: unsupported("openDirReader"),
    watch: unsupported("watch"),
    canonicalPath: (path, context) => canonicalPath(workspace, path, context),
    exists: (path, context) => exists(workspace, path, context),
    createDir: unsupported("createDir"),
    remove: unsupported("remove"),
    createTempDir: (prefix, context) => createTempDir(workspace, running, prefix, context),
    createTempFile: (tempOptions, context) => createTempFile(workspace, tempOptions, context),
    exec: (command, execOptions, context) =>
      execInWorkspace(workspace, running, command, execOptions, context),
    cleanup: () => killAll(workspace, running),
  };
}
