import type { ExecutionEnv } from "@cf-stumble/pi";
import type { ProjectRpcTargetContract } from "../../workspace/project/protocol.js";
import { execViaProjectTarget } from "./execution-env-exec.js";
import {
  absolutePathVia,
  canonicalPathVia,
  createTempFileVia,
  existsVia,
  fileInfoVia,
  readTextFileVia,
  readBinaryFileVia,
  unsupportedError,
  writeVia,
} from "./execution-env-filesystem.js";

interface FacetExecutionEnvLocal {
  /** A starting point only: every path is checked against the workspace root, so a `cwd` outside it yields rejected operations. */
  readonly cwd: string;
  readonly projectTarget: ProjectRpcTargetContract;
  readonly turnDeadlineAt?: number;
  readonly now?: () => number;
}

/**
 * `cwd` and `projectTarget` are captured by closure only, so the returned object exposes no project
 * target. Every method resolves a `Result` rather than throwing.
 */
export function createFacetExecutionEnv(local: FacetExecutionEnvLocal): ExecutionEnv {
  const { cwd, projectTarget, turnDeadlineAt, now = Date.now } = local;
  const budget = turnDeadlineAt === undefined ? undefined : { deadlineAt: turnDeadlineAt, now };

  return {
    cwd,
    absolutePath: (path, abortSignal) => Promise.resolve(absolutePathVia(cwd, path, abortSignal)),
    joinPath: () => Promise.resolve(unsupportedError("joinPath")),
    readTextFile: (path, abortSignal) => readTextFileVia(cwd, projectTarget, path, abortSignal),
    readTextLines: (path) => Promise.resolve(unsupportedError("readTextLines", path)),
    readBinaryFile: (path, abortSignal) => readBinaryFileVia(cwd, projectTarget, path, abortSignal),
    writeFile: (path, content, abortSignal) =>
      writeVia(cwd, projectTarget, path, content, "overwrite", abortSignal),
    appendFile: (path, content, abortSignal) =>
      writeVia(cwd, projectTarget, path, content, "append", abortSignal),
    renameFile: (sourcePath) => Promise.resolve(unsupportedError("renameFile", sourcePath)),
    fileInfo: (path, abortSignal) => fileInfoVia(cwd, projectTarget, path, abortSignal),
    listDir: (path) => Promise.resolve(unsupportedError("listDir", path)),
    canonicalPath: (path, abortSignal) => canonicalPathVia(cwd, projectTarget, path, abortSignal),
    exists: (path, abortSignal) => existsVia(cwd, projectTarget, path, abortSignal),
    createDir: (path) => Promise.resolve(unsupportedError("createDir", path)),
    remove: (path) => Promise.resolve(unsupportedError("remove", path)),
    createTempDir: () => Promise.resolve(unsupportedError("createTempDir")),
    createTempFile: (options) => createTempFileVia(projectTarget, options),
    cleanup: () => Promise.resolve(),
    exec: (command, options) => execViaProjectTarget(cwd, projectTarget, command, options, budget),
  };
}
