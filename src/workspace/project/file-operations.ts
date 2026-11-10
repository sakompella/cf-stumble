import * as Result from "effect/Result";
import {
  mapProviderError,
  type ProjectFilesystemProvider,
  type ProjectTransactions,
} from "./provider.js";
import {
  addressedPathOf,
  fileInfoOf,
  joinOne,
  parseAddressedPath,
  resolveAddressedPath,
  resolveCanonicalPath,
} from "./resolve.js";
import {
  failureDetail,
  ok,
  MAX_FILE_BYTES,
  type ProjectFailureDetail,
  type ProjectLstatInfo,
  type ProjectResult,
  type WriteFileWire,
  type WriteMode,
} from "./protocol.js";
import { parseWriteFileInput } from "./start-exec-input.js";

export function projectResultOf<T>(result: Result.Result<T, ProjectFailureDetail>): ProjectResult<T> {
  return Result.match(result, {
    onFailure: (error): ProjectResult<T> => ({ ok: false, error }),
    onSuccess: (value) => ok(value),
  });
}

export function lstatProjectPath(
  provider: ProjectFilesystemProvider,
  path: string,
): Result.Result<ProjectLstatInfo, ProjectFailureDetail> {
  return Result.gen(function* () {
    const segments = yield* parseAddressedPath(path);

    const outcome = yield* resolveAddressedPath(provider, segments, {
      followFinalSymlink: false,
      createMissingDirs: false,
    });

    if (outcome.kind === "missing") {
      return yield* Result.fail(failureDetail("not-found", addressedPathOf(segments)));
    }

    const name = segments.at(-1) ?? "/";

    const info = fileInfoOf(
      provider,
      name,
      addressedPathOf(segments),
      outcome.path,
      outcome.stat,
    );

    return { ...info, canonicalPath: projectResultOf(resolveCanonicalPath(provider, segments)) };
  });
}

export function readProjectFile(
  provider: ProjectFilesystemProvider,
  path: string,
): Result.Result<Uint8Array, ProjectFailureDetail> {
  return Result.gen(function* () {
    const segments = yield* parseAddressedPath(path);

    const outcome = yield* resolveAddressedPath(provider, segments, {
      followFinalSymlink: true,
      createMissingDirs: false,
    });

    const addressed = addressedPathOf(segments);

    if (outcome.kind === "missing") {
      return yield* Result.fail(failureDetail("not-found", addressed));
    }

    if (outcome.stat.isDirectory()) {
      return yield* Result.fail(failureDetail("is-directory", addressed));
    }

    if (outcome.stat.size > MAX_FILE_BYTES) {
      return yield* Result.fail(failureDetail("content-too-large", addressed));
    }

    try {
      return provider.readFileSync(outcome.path);
    } catch (cause) {
      return yield* Result.fail(failureDetail(mapProviderError(cause), addressed));
    }
  });
}

function resolveWriteTarget(
  provider: ProjectFilesystemProvider,
  segments: readonly string[],
  mode: WriteMode,
): Result.Result<{ path: string; flag: "w" | "a" | "wx" }, ProjectFailureDetail> {
  return Result.gen(function* () {
    const addressed = addressedPathOf(segments);

    if (mode === "create-exclusive") {
      const outcome = yield* resolveAddressedPath(provider, segments, {
        followFinalSymlink: false,
        createMissingDirs: true,
      });

      if (outcome.kind === "resolved") {
        return yield* Result.fail(failureDetail("already-exists", addressed));
      }

      return { path: joinOne(outcome.parentPath, outcome.name), flag: "wx" };
    }

    const outcome = yield* resolveAddressedPath(provider, segments, {
      followFinalSymlink: true,
      createMissingDirs: true,
    });

    if (outcome.kind === "resolved") {
      if (outcome.stat.isDirectory()) {
        return yield* Result.fail(failureDetail("is-directory", addressed));
      }

      return { path: outcome.path, flag: mode === "append" ? "a" : "w" };
    }

    return { path: joinOne(outcome.parentPath, outcome.name), flag: mode === "append" ? "a" : "w" };
  });
}

export function writeProjectFile(
  provider: ProjectFilesystemProvider,
  transactions: ProjectTransactions,
  input: WriteFileWire,
): Result.Result<null, ProjectFailureDetail> {
  return Result.gen(function* () {
    const parsed = yield* parseWriteFileInput(input);
    const { bytes, mode } = parsed;
    const segments = yield* parseAddressedPath(parsed.path);
    const addressed = addressedPathOf(segments);

    if (bytes.byteLength > MAX_FILE_BYTES) {
      return yield* Result.fail(failureDetail("content-too-large", addressed));
    }

    const target = yield* resolveWriteTarget(provider, segments, mode);

    try {
      transactions.transactionSync(() => {
        const fd = provider.openSync(target.path, target.flag);

        try {
          provider.writeSync(fd, bytes);
        } finally {
          provider.closeSync(fd);
        }
      });

      return null;
    } catch (cause) {
      return yield* Result.fail(failureDetail(mapProviderError(cause), addressed));
    }
  });
}
