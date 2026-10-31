import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { ProjectRpcTargetContract } from "../../workspace/project/protocol.js";
import { execInWorkspace, killAll, type RunningCommands } from "./execution-env-exec.js";
import {
  absolutePath,
  canonicalPath,
  createTempFile,
  exists,
  fileInfo,
  flushFile,
  listDir,
  readBytes,
  readTextFile,
  truncateFile,
  writeBytes,
} from "./execution-env-files.js";
import { joinPath, type ComputerWorkspace } from "./execution-env-paths.js";
import { createDir, createTempDir, remove, renameFile } from "./execution-env-posix.js";
import {
  openBinaryReader,
  openDirReader,
  openTextLineReader,
  readTextLines,
} from "./execution-env-readers.js";
import { watch } from "./execution-env-watch.js";

export const COMPUTER_ENV_ID = "cf-stumble:computer-workspace";

export interface ComputerEnvOptions {
  readonly cwd: string;
  readonly target: ProjectRpcTargetContract;
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
    openTextLineReader: (path, context) => openTextLineReader(workspace, path, context),
    readTextLines: (path, lineOptions, context) =>
      readTextLines(workspace, path, lineOptions?.maxLines, context),
    readBinaryFile: (path, context) => readBytes(workspace, path, context),
    openBinaryReader: (path, readerOptions, context) =>
      openBinaryReader(workspace, path, readerOptions?.noFollow === true, context),
    writeFile: (path, content, context) =>
      writeBytes(workspace, path, content, "overwrite", context),
    appendFile: (path, content, context) => writeBytes(workspace, path, content, "append", context),
    truncateFile: (path, size, context) => truncateFile(workspace, path, size, context),
    flushFile: (path, context) => flushFile(workspace, path, context),
    renameFile: (source, destination, context) =>
      renameFile(workspace, running, source, destination, context),
    fileInfo: (path, context) => fileInfo(workspace, path, context),
    listDir: (path, context) => listDir(workspace, path, context),
    openDirReader: (path, context) => openDirReader(workspace, path, context),
    watch: (targets, onChange, context) => watch(workspace, targets, onChange, context),
    canonicalPath: (path, context) => canonicalPath(workspace, path, context),
    exists: (path, context) => exists(workspace, path, context),
    createDir: (path, dirOptions, context) =>
      createDir(workspace, running, path, dirOptions, context),
    remove: (path, removeOptions, context) =>
      remove(workspace, running, path, removeOptions, context),
    createTempDir: (prefix, context) => createTempDir(workspace, running, prefix, context),
    createTempFile: (tempOptions, context) => createTempFile(workspace, tempOptions, context),
    exec: (command, execOptions, context) =>
      execInWorkspace(workspace, running, command, execOptions, context),
    cleanup: () => killAll(workspace, running),
  };
}
