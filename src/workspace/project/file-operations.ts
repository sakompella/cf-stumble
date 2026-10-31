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
  fail,
  MAX_FILE_BYTES,
  MAX_LIST_BYTES,
  MAX_LIST_ENTRIES,
  ok,
  type ProjectFileInfo,
  type ProjectListing,
  type ProjectLstatInfo,
  type ProjectResult,
  type WriteFileWire,
  type WriteMode,
} from "./protocol.js";
import { parseWriteFileInput } from "./start-exec-input.js";

export function lstatProjectPath(
  provider: ProjectFilesystemProvider,
  path: string,
): ProjectResult<ProjectLstatInfo> {
  const segments = parseAddressedPath(path);

  if (!segments.ok) return segments;

  const outcome = resolveAddressedPath(provider, segments.value, {
    followFinalSymlink: false,
    createMissingDirs: false,
  });

  if (!outcome.ok) return outcome;

  if (outcome.value.kind === "missing") return fail("not-found", addressedPathOf(segments.value));

  const name = segments.value.at(-1) ?? "/";

  const info = fileInfoOf(
    provider,
    name,
    addressedPathOf(segments.value),
    outcome.value.path,
    outcome.value.stat,
  );

  const canonicalPath = resolveCanonicalPath(provider, segments.value);

  return ok({ ...info, canonicalPath });
}

export function readProjectFile(
  provider: ProjectFilesystemProvider,
  path: string,
): ProjectResult<Uint8Array> {
  const segments = parseAddressedPath(path);

  if (!segments.ok) return segments;

  const outcome = resolveAddressedPath(provider, segments.value, {
    followFinalSymlink: true,
    createMissingDirs: false,
  });

  if (!outcome.ok) return outcome;

  if (outcome.value.kind === "missing") return fail("not-found", addressedPathOf(segments.value));

  if (outcome.value.stat.isDirectory()) {
    return fail("is-directory", addressedPathOf(segments.value));
  }

  if (outcome.value.stat.size > MAX_FILE_BYTES) {
    return fail("content-too-large", addressedPathOf(segments.value));
  }

  try {
    return ok(provider.readFileSync(outcome.value.path));
  } catch (cause) {
    return fail(mapProviderError(cause), addressedPathOf(segments.value));
  }
}

function resolveWriteTarget(
  provider: ProjectFilesystemProvider,
  segments: readonly string[],
  mode: WriteMode,
): ProjectResult<{ path: string; flag: "w" | "a" | "wx" }> {
  const addressed = addressedPathOf(segments);

  if (mode === "create-exclusive") {
    const outcome = resolveAddressedPath(provider, segments, {
      followFinalSymlink: false,
      createMissingDirs: true,
    });

    if (!outcome.ok) return outcome;

    if (outcome.value.kind === "resolved") return fail("already-exists", addressed);

    return ok({ path: joinOne(outcome.value.parentPath, outcome.value.name), flag: "wx" });
  }

  const outcome = resolveAddressedPath(provider, segments, {
    followFinalSymlink: true,
    createMissingDirs: true,
  });

  if (!outcome.ok) return outcome;

  if (outcome.value.kind === "resolved") {
    if (outcome.value.stat.isDirectory()) return fail("is-directory", addressed);

    return ok({ path: outcome.value.path, flag: mode === "append" ? "a" : "w" });
  }

  return ok({
    path: joinOne(outcome.value.parentPath, outcome.value.name),
    flag: mode === "append" ? "a" : "w",
  });
}

export function writeProjectFile(
  provider: ProjectFilesystemProvider,
  transactions: ProjectTransactions,
  input: WriteFileWire,
): ProjectResult<null> {
  const parsed = parseWriteFileInput(input);

  if (!parsed.ok) return parsed;

  const { bytes, mode } = parsed.value;
  const segments = parseAddressedPath(parsed.value.path);

  if (!segments.ok) return segments;

  const addressed = addressedPathOf(segments.value);

  if (bytes.byteLength > MAX_FILE_BYTES) return fail("content-too-large", addressed);

  const target = resolveWriteTarget(provider, segments.value, mode);

  if (!target.ok) return target;

  try {
    transactions.transactionSync(() => {
      const fd = provider.openSync(target.value.path, target.value.flag);

      try {
        provider.writeSync(fd, bytes);
      } finally {
        provider.closeSync(fd);
      }
    });

    return ok(null);
  } catch (cause) {
    return fail(mapProviderError(cause), addressed);
  }
}

export function listProjectDirectory(
  provider: ProjectFilesystemProvider,
  path: string,
): ProjectResult<ProjectListing> {
  const segments = parseAddressedPath(path);

  if (!segments.ok) return segments;

  const outcome = resolveAddressedPath(provider, segments.value, {
    followFinalSymlink: true,
    createMissingDirs: false,
  });

  if (!outcome.ok) return outcome;

  if (outcome.value.kind === "missing") return fail("not-found", addressedPathOf(segments.value));

  if (!outcome.value.stat.isDirectory()) {
    return fail("not-directory", addressedPathOf(segments.value));
  }

  const directoryPath = outcome.value.path;

  try {
    const names = provider
      .readdirSync(directoryPath, { withFileTypes: true })
      .map((entry) => entry.name)
      .toSorted((a, b) => a.localeCompare(b));

    const entries: ProjectFileInfo[] = [];
    let bytes = 0;

    for (const name of names) {
      const childAddressed = joinOne(addressedPathOf(segments.value), name);
      bytes += new TextEncoder().encode(childAddressed).length;

      if (entries.length >= MAX_LIST_ENTRIES || bytes > MAX_LIST_BYTES) {
        return ok({ entries, truncated: true });
      }

      const childProviderPath = joinOne(directoryPath, name);
      const stat = provider.lstatSync(childProviderPath);
      entries.push(fileInfoOf(provider, name, childAddressed, childProviderPath, stat));
    }

    return ok({ entries, truncated: false });
  } catch (cause) {
    return fail(mapProviderError(cause), addressedPathOf(segments.value));
  }
}
