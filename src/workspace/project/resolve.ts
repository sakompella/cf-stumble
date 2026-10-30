import { WORKSPACE_ROOT } from "../../workspace-layout.js";
import { mapProviderError, type ProjectFilesystemProvider, type ProjectStat } from "./provider.js";
import {
  fail,
  ok,
  type ProjectFileInfo,
  type ProjectFileKind,
  type ProjectResult,
} from "./protocol.js";

/**
 * `workspace-layout.ts` owns the root and the facet's path-escape guard reads the same constant, so
 * address translation and the guard cannot disagree. The root is the whole workspace, so an agent
 * can read a sibling repository; project selection chooses a working directory, not a boundary.
 */

/** Linux's own symlink-follow cap (`MAXSYMLINKS`), across one whole resolve call. */
const MAX_SYMLINK_FOLLOWS = 40;

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This is the RPC path-parsing boundary.
export function parseAddressedPath(input: unknown): ProjectResult<readonly string[]> {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Boundary: the RPC path argument is untrusted.
  if (typeof input !== "string") return fail("invalid-request");

  if (input.includes("\\") || input.includes("\0")) return fail("invalid-request");

  if (!input.startsWith("/")) return fail("invalid-request");

  if (input === "/") return ok([]);
  const segments: string[] = [];

  for (const segment of input.slice(1).split("/")) {
    if (segment === "" || segment === "." || segment === "..") return fail("invalid-request");
    segments.push(segment);
  }

  return ok(segments);
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

type SegmentStep =
  | { kind: "continue"; resolved: string }
  | { kind: "settle"; result: ProjectResult<ResolveOutcome> };

function stepPastMissing(
  provider: ProjectFilesystemProvider,
  options: ResolveOptions,
  place: { resolved: string; candidate: string; segment: string; isLast: boolean },
  addressed: string,
): SegmentStep {
  if (!place.isLast) {
    if (!options.createMissingDirs) return { kind: "settle", result: fail("not-found", addressed) };
    provider.mkdirSync(place.candidate);

    return { kind: "continue", resolved: place.candidate };
  }

  return {
    kind: "settle",
    result: ok({ kind: "missing", parentPath: place.resolved, name: place.segment }),
  };
}

function stepPastSymlink(
  provider: ProjectFilesystemProvider,
  queue: string[],
  place: { resolved: string; candidate: string },
  linkFollows: number,
  addressed: string,
): SegmentStep {
  if (linkFollows > MAX_SYMLINK_FOLLOWS)
    return { kind: "settle", result: fail("symlink-loop", addressed) };
  const target = provider.readlinkSync(place.candidate);
  queue.unshift(...splitTarget(target));

  // An absolute target restarts from the root; a relative one resolves against the symlink's containing directory.
  return { kind: "continue", resolved: target.startsWith("/") ? "/" : place.resolved };
}

function stepPastNode(
  provider: ProjectFilesystemProvider,
  options: ResolveOptions,
  queue: string[],
  place: { resolved: string; candidate: string; stat: ProjectStat; isLast: boolean },
  linkFollows: number,
  addressed: string,
): SegmentStep {
  if (place.stat.isSymbolicLink() && (!place.isLast || options.followFinalSymlink)) {
    return stepPastSymlink(provider, queue, place, linkFollows, addressed);
  }

  if (place.isLast)
    return {
      kind: "settle",
      result: ok({ kind: "resolved", path: place.candidate, stat: place.stat }),
    };

  if (!place.stat.isDirectory())
    return { kind: "settle", result: fail("not-directory", addressed) };

  return { kind: "continue", resolved: place.candidate };
}

function stepOneSegment(
  provider: ProjectFilesystemProvider,
  options: ResolveOptions,
  queue: string[],
  place: { resolved: string; candidate: string; segment: string; isLast: boolean },
  linkFollows: number,
  addressed: string,
): SegmentStep {
  try {
    const stat = provider.lstatSync(place.candidate);

    return stepPastNode(provider, options, queue, { ...place, stat }, linkFollows + 1, addressed);
  } catch (error) {
    const code = mapProviderError(error);

    if (code !== "not-found") return { kind: "settle", result: fail(code, addressed) };

    return stepPastMissing(provider, options, place, addressed);
  }
}

/**
 * `provider.realpath()` only normalizes lexically, so each component is walked with
 * `lstatSync`/`readlinkSync`. The root boundary is checked after every step that changes position,
 * so an escape is caught when it happens.
 */
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

  while (queue.length > 0) {
    const segment = queue.shift()!;

    if (segment === ".") continue;

    if (segment === "..") {
      resolved = resolved === "/" ? "/" : resolved.slice(0, resolved.lastIndexOf("/")) || "/";

      if (!isWithinRoot(resolved)) return fail("path-outside-root", addressed);
      continue;
    }

    const candidate = joinOne(resolved, segment);

    if (!isWithinRoot(candidate)) return fail("path-outside-root", addressed);
    const isLast = queue.length === 0;

    const step = stepOneSegment(
      provider,
      options,
      queue,
      { resolved, candidate, segment, isLast },
      linkFollows,
      addressed,
    );

    if (step.kind === "settle") return step.result;

    if (step.resolved !== candidate) linkFollows += 1;
    resolved = step.resolved;
  }

  // Only reachable via a symlink target that fully consumes the queue without leaving a final
  // component to settle on, e.g. a target of "." or "/".
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
  } catch (error) {
    return fail(mapProviderError(error), addressed);
  }
}

function kindOf(stat: ProjectStat): ProjectFileKind {
  if (stat.isSymbolicLink()) return "symlink";

  return stat.isDirectory() ? "directory" : "file";
}

/** Byte-accurate size: a symlink's stored size is a UTF-16 code-unit count, not a byte count. */
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
