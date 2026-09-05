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

export interface FacetExecutionEnvLocal {
  /**
   * Where the turn starts. It is the selected project's directory in the shared workspace, so
   * relative paths land in that repository, and it is only a starting point: every path this
   * environment resolves is checked against the workspace root itself, so a `cwd` outside the root
   * yields rejected operations rather than an escape.
   */
  readonly cwd: string;
  readonly projectTarget: ProjectRpcTargetContract;
}

/**
 * Builds a Pi `ExecutionEnv` local to one turn: every filesystem and shell operation Pi's stock
 * tools need, translated onto the six-method `ProjectRpcTarget` surface. `cwd` and `projectTarget`
 * are captured by closure only, so the returned object carries no `projectTarget` property —
 * enumerable or otherwise — and reaches no build, fetch, raw Computer, or container capability.
 * Every method resolves a `Result` rather than throwing or rejecting, including the seven methods
 * this environment does not implement and every already-aborted call. The actual translation and
 * error-mapping logic lives in `execution-env-filesystem.ts` and `execution-env-exec.ts`: this
 * function only binds that logic to one `{ cwd, projectTarget }` pair.
 */
export function createFacetExecutionEnv(local: FacetExecutionEnvLocal): ExecutionEnv {
  const { cwd, projectTarget } = local;

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
    exec: (command, options) => execViaProjectTarget(cwd, projectTarget, command, options),
  };
}
