import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { WORKSPACE_ROOT } from "../../workspace-layout.js";
import { mapProviderError, type ProjectFilesystemProvider, type ProjectStat } from "./provider.js";
import {
  fail,
  ok,
  type ProjectFileInfo,
  type ProjectFileKind,
  type ProjectResult,
} from "./protocol.js";

const MAX_SYMLINK_FOLLOWS = 40;

const PATH_SEGMENT = String.raw`(?![.]{1,2}(?:/|$))[^\\\u0000/]+`;

const ADDRESSED_PATH_PATTERN = new RegExp(`^(?:/|(?:/${PATH_SEGMENT})+)$`, "u");

export const AddressedPathText = Schema.String.check(Schema.isPattern(ADDRESSED_PATH_PATTERN));

export const decodeAddressedPathText = Schema.decodeResult(AddressedPathText);

export function segmentsOfAddressedPath(path: string): readonly string[] {
  return path === "/" ? [] : path.slice(1).split("/");
}

export function parseAddressedPath(path: string): ProjectResult<readonly string[]> {
  const decoded = decodeAddressedPathText(path);

  return Result.isFailure(decoded)
    ? fail("invalid-request")
    : ok(segmentsOfAddressedPath(decoded.success));
}

export function addressedPathOf(segments: readonly string[]): string {
  return segments.length === 0 ? "/" : `/${segments.join("/")}`;
}

function addressedFromProviderPath(path: string): string {
  return path === WORKSPACE_ROOT ? "/" : path.slice(WORKSPACE_ROOT.length);
}

function joinOne(base: string, name: string): string {
  return base === "/" ? `/${name}` : `${base}/${name}`;
}

function isWithinRoot(path: string): boolean {
  return path === WORKSPACE_ROOT || path.startsWith(`${WORKSPACE_ROOT}/`);
}

function splitTarget(target: string): string[] {
  return target.split("/").filter((part) => part.length > 0);
}

type ResolveOutcome =
  | { kind: "resolved"; path: string; stat: ProjectStat }
  | { kind: "missing"; parentPath: string; name: string };

interface ResolveOptions {
  followFinalSymlink: boolean;
  createMissingDirs: boolean;
}

export function resolveAddressedPath(
  provider: ProjectFilesystemProvider,
  segments: readonly string[],
  options: ResolveOptions,
): ProjectResult<ResolveOutcome> {
  if (segments.length === 0) return statAt(provider, WORKSPACE_ROOT, "/");

  const addressed = addressedPathOf(segments);
  let resolved = WORKSPACE_ROOT;
  const queue: string[] = [...segments];
  let linkFollows = 0;

  for (let segment = queue.shift(); segment !== undefined; segment = queue.shift()) {
    if (segment === ".") continue;

    if (segment === "..") {
      resolved = resolved === "/" ? "/" : resolved.slice(0, resolved.lastIndexOf("/")) || "/";

      if (!isWithinRoot(resolved)) return fail("path-outside-root", addressed);
      continue;
    }

    const candidate = joinOne(resolved, segment);

    if (!isWithinRoot(candidate)) return fail("path-outside-root", addressed);

    const isLast = queue.length === 0;
    let stat: ProjectStat;

    try {
      stat = provider.lstatSync(candidate);
    } catch (cause) {
      const code = mapProviderError(cause);

      if (code !== "not-found") return fail(code, addressed);

      if (!isLast) {
        if (!options.createMissingDirs) return fail("not-found", addressed);
        provider.mkdirSync(candidate);
        resolved = candidate;

        continue;
      }

      return ok({ kind: "missing", parentPath: resolved, name: segment });
    }

    if (stat.isSymbolicLink() && (!isLast || options.followFinalSymlink)) {
      if (linkFollows >= MAX_SYMLINK_FOLLOWS) return fail("symlink-loop", addressed);

      const target = provider.readlinkSync(candidate);
      queue.unshift(...splitTarget(target));
      linkFollows += 1;
      resolved = target.startsWith("/") ? "/" : resolved;

      continue;
    }

    if (isLast) return ok({ kind: "resolved", path: candidate, stat });

    if (!stat.isDirectory()) return fail("not-directory", addressed);

    resolved = candidate;
  }

  if (!isWithinRoot(resolved)) return fail("path-outside-root", addressed);

  return statAt(provider, resolved, addressed);
}

function statAt(
  provider: ProjectFilesystemProvider,
  path: string,
  addressed: string,
): ProjectResult<ResolveOutcome> {
  try {
    return ok({ kind: "resolved", path, stat: provider.lstatSync(path) });
  } catch (cause) {
    return fail(mapProviderError(cause), addressed);
  }
}

function kindOf(stat: ProjectStat): ProjectFileKind {
  if (stat.isSymbolicLink()) return "symlink";

  return stat.isDirectory() ? "directory" : "file";
}

function byteAccurateSize(
  provider: ProjectFilesystemProvider,
  path: string,
  stat: ProjectStat,
): number {
  if (!stat.isSymbolicLink()) return stat.size;

  return new TextEncoder().encode(provider.readlinkSync(path)).length;
}

export function fileInfoOf(
  provider: ProjectFilesystemProvider,
  name: string,
  addressedPath: string,
  providerPath: string,
  stat: ProjectStat,
): ProjectFileInfo {
  return {
    name,
    path: addressedPath,
    kind: kindOf(stat),
    size: byteAccurateSize(provider, providerPath, stat),
    mtimeMs: stat.mtimeMs,
  };
}

export function resolveCanonicalPath(
  provider: ProjectFilesystemProvider,
  segments: readonly string[],
): ProjectResult<string> {
  const outcome = resolveAddressedPath(provider, segments, {
    followFinalSymlink: true,
    createMissingDirs: false,
  });

  if (!outcome.ok) return outcome;

  if (outcome.value.kind === "missing") return fail("not-found", addressedPathOf(segments));

  return ok(addressedFromProviderPath(outcome.value.path));
}

export { joinOne };
