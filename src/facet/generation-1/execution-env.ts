import { FileError, type ExecutionEnv, type Result } from "@earendil-works/pi-durable/env";
import type { GenerationControl } from "../../generation-requests.js";
import type {
  ExecBackendChoice,
  ProjectRpcTargetContract,
} from "../../workspace/project/protocol.js";
import { execInWorkspace, killAll, type RunningCommands } from "./execution-env-exec.js";
import {
  absolutePath,
  canonicalPath,
  exists,
  fileInfo,
  readTextFile,
  writeBytes,
} from "./execution-env-files.js";
import { joinPath, type ComputerWorkspace } from "./execution-env-paths.js";
import { openBinaryReader } from "./execution-env-readers.js";
import { runStumbleCommand, stumbleArguments } from "./stumble-command.js";

const COMPUTER_ENV_ID = "cf-stumble:computer-workspace";

export interface ComputerEnvOptions {
  readonly cwd: string;
  readonly target: ProjectRpcTargetContract;
  readonly generations?: GenerationControl | undefined;
}

function unsupported(member: string): () => Promise<Result<never, FileError>> {
  const message = `the Computer workspace does not provide ${member}`;

  return () => Promise.resolve({ ok: false, error: new FileError("not_supported", message) });
}

export interface ComputerEnv extends ExecutionEnv {
  onBackend(backend: ExecBackendChoice): ExecutionEnv;
}

export function createComputerEnv(options: ComputerEnvOptions): ComputerEnv {
  const running: RunningCommands = new Set();
  const { generations } = options;

  const envFor = (workspace: ComputerWorkspace): ComputerEnv => ({
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
    createTempDir: unsupported("createTempDir"),
    createTempFile: unsupported("createTempFile"),
    exec: (command, execOptions, context) => {
      const stumble = generations === undefined ? undefined : stumbleArguments(command);

      return stumble === undefined || generations === undefined
        ? execInWorkspace(workspace, running, command, execOptions, context)
        : runStumbleCommand(stumble, { generations }, execOptions, context);
    },
    cleanup: () => killAll(workspace, running),
    onBackend: (backend) => envFor({ ...workspace, backend }),
  });

  return envFor({ cwd: options.cwd, target: options.target });
}
