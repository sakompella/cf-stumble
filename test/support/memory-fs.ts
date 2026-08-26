/**
 * An in-memory `FsClient` for isomorphic-git that works inside workerd.
 *
 * isomorphic-git is our independent oracle for the git object codec: a second implementation
 * written by other people, so agreement between it and `src/git/` is real evidence rather than
 * our decoder agreeing with our encoder. We previously used the `git` binary for this, which
 * needs a subprocess and so pinned those tests to Node.
 *
 * Note the method set. A call-counting experiment suggested only `mkdir`, `readFile`, `stat`
 * and `writeFile` are ever invoked for our workload, which was misleading: isomorphic-git
 * *binds* every method when it constructs its filesystem wrapper, so omitting one fails with a
 * bare "Cannot read properties of undefined (reading 'bind')" long before anything calls it.
 * All ten are provided; the unused ones fail loudly rather than pretending to work.
 */

type Stats = {
  isDirectory: () => boolean;
  isFile: () => boolean;
  isSymbolicLink: () => boolean;
  size: number;
  mtimeMs: number;
  mode: number;
};

type FsPromises = {
  mkdir: (path: string) => Promise<void>;
  writeFile: (path: string, data: Uint8Array | string) => Promise<void>;
  readFile: (
    path: string,
    options?: { readonly encoding?: string } | string,
  ) => Promise<Uint8Array | string>;
  stat: (path: string) => Promise<Stats>;
  lstat: (path: string) => Promise<Stats>;
  readdir: (path: string) => Promise<readonly string[]>;
  rmdir: (path: string) => Promise<void>;
  unlink: (path: string) => Promise<void>;
  readlink: (path: string) => Promise<string>;
  symlink: (target: string, path: string) => Promise<void>;
};

/** Carries the `code` property isomorphic-git branches on, without asserting a widened type. */
class FsError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "FsError";
    this.code = code;
  }
}

const enoent = (path: string): FsError =>
  new FsError("ENOENT", `ENOENT: no such file or directory, '${path}'`);

const statsFor = (size: number, directory: boolean): Stats => ({
  isDirectory: () => directory,
  isFile: () => !directory,
  isSymbolicLink: () => false,
  size,
  mtimeMs: 0,
  mode: directory ? 0o040_000 : 0o100_644,
});

function decodeIfRequested(
  content: Uint8Array,
  options: { readonly encoding?: string } | string | undefined,
): Uint8Array | string {
  // isomorphic-git's FsClient calls readFile(path) for bytes and readFile(path, "utf8") for
  // text. That primitive-or-object union is imposed by the library, so typeof is the only
  // discriminator available for the primitive arm.
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- external FsClient overload boundary.
  const encoding = typeof options === "string" ? options : options?.encoding;
  return encoding === undefined || encoding === ""
    ? content.slice()
    : new TextDecoder().decode(content);
}

function childNames(files: ReadonlyMap<string, Uint8Array>, path: string): readonly string[] {
  const prefix = path.endsWith("/") ? path : `${path}/`;
  const names = new Set<string>();
  for (const key of files.keys()) {
    if (!key.startsWith(prefix)) continue;
    const child = key.slice(prefix.length).split("/")[0];
    if (child !== undefined && child !== "") names.add(child);
  }
  return [...names];
}

export type MemoryFs = {
  promises: FsPromises;
  /** Every path currently holding content, for asserting on what git laid down. */
  paths: () => readonly string[];
  read: (path: string) => Uint8Array | undefined;
};

function makePromises(files: Map<string, Uint8Array>, directories: Set<string>): FsPromises {
  const stat = (path: string): Promise<Stats> => {
    if (directories.has(path)) return Promise.resolve(statsFor(0, true));
    const content = files.get(path);
    return content === undefined
      ? Promise.reject(enoent(path))
      : Promise.resolve(statsFor(content.byteLength, false));
  };

  return {
    mkdir: (path: string): Promise<void> => {
      directories.add(path);
      return Promise.resolve();
    },
    writeFile: (path: string, data: Uint8Array | string): Promise<void> => {
      files.set(path, data instanceof Uint8Array ? data.slice() : new TextEncoder().encode(data));
      return Promise.resolve();
    },
    readFile: (
      path: string,
      options?: { readonly encoding?: string } | string,
    ): Promise<Uint8Array | string> => {
      const content = files.get(path);
      return content === undefined
        ? Promise.reject(enoent(path))
        : Promise.resolve(decodeIfRequested(content, options));
    },
    stat,
    lstat: stat,
    readdir: (path: string): Promise<readonly string[]> => Promise.resolve(childNames(files, path)),
    rmdir: (path: string): Promise<void> => {
      directories.delete(path);
      return Promise.resolve();
    },
    unlink: (path: string): Promise<void> => {
      files.delete(path);
      return Promise.resolve();
    },
    // Never exercised by the object-writing workload, but isomorphic-git binds them on
    // construction, so they must exist. Failing loudly beats returning something wrong.
    readlink: (path: string): Promise<string> => Promise.reject(enoent(path)),
    symlink: (): Promise<void> =>
      Promise.reject(new FsError("ENOSYS", "symlink is not supported by the in-memory test fs")),
  };
}

export function createMemoryFs(): MemoryFs {
  const files = new Map<string, Uint8Array>();
  const directories = new Set<string>(["/"]);

  return {
    promises: makePromises(files, directories),
    paths: () => [...files.keys()],
    read: (path: string) => files.get(path)?.slice(),
  };
}
