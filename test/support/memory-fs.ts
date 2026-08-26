/**
 * An in-memory `FsClient` for isomorphic-git that works inside workerd.
 *
 * isomorphic-git is our independent oracle for the git object codec: it is a second
 * implementation written by other people, so agreement between it and `src/git/` is real
 * evidence rather than our decoder agreeing with our encoder. We previously used the `git`
 * binary for this, which forced those tests onto Node because it needs a subprocess.
 *
 * Note the method set. A call-counting experiment suggested only `mkdir`, `readFile`, `stat`
 * and `writeFile` are ever invoked for our workload, which was misleading: isomorphic-git
 * *binds* every method when it constructs its filesystem wrapper, so omitting one fails with a
 * bare "Cannot read properties of undefined (reading 'bind')" long before anything calls it.
 * All ten are provided; the unused ones throw or no-op honestly rather than pretending.
 */

type Stats = {
  isDirectory: () => boolean;
  isFile: () => boolean;
  isSymbolicLink: () => boolean;
  size: number;
  mtimeMs: number;
  mode: number;
};

function enoent(path: string): Error {
  const error = new Error(`ENOENT: no such file or directory, '${path}'`) as Error & {
    code: string;
  };
  error.code = "ENOENT";
  return error;
}

function statsFor(size: number, directory: boolean): Stats {
  return {
    isDirectory: () => directory,
    isFile: () => !directory,
    isSymbolicLink: () => false,
    size,
    mtimeMs: 0,
    mode: directory ? 0o040_000 : 0o100_644,
  };
}

export type MemoryFs = {
  promises: Record<string, unknown>;
  /** Every path currently holding content, for asserting on what git laid down. */
  paths: () => readonly string[];
  read: (path: string) => Uint8Array | undefined;
};

export function createMemoryFs(): MemoryFs {
  const files = new Map<string, Uint8Array>();
  const directories = new Set<string>(["/"]);

  const promises = {
    mkdir(path: string): Promise<void> {
      directories.add(path);
      return Promise.resolve();
    },

    writeFile(path: string, data: Uint8Array | string): Promise<void> {
      files.set(path, typeof data === "string" ? new TextEncoder().encode(data) : data.slice());
      return Promise.resolve();
    },

    readFile(
      path: string,
      options?: { readonly encoding?: string } | string,
    ): Promise<Uint8Array | string> {
      const content = files.get(path);
      if (content === undefined) {
        return Promise.reject(enoent(path));
      }
      const encoding = typeof options === "string" ? options : options?.encoding;
      return Promise.resolve(encoding ? new TextDecoder().decode(content) : content.slice());
    },

    stat(path: string): Promise<Stats> {
      if (directories.has(path)) {
        return Promise.resolve(statsFor(0, true));
      }
      const content = files.get(path);
      if (content === undefined) {
        return Promise.reject(enoent(path));
      }
      return Promise.resolve(statsFor(content.byteLength, false));
    },

    lstat(path: string): Promise<Stats> {
      return promises.stat(path);
    },

    readdir(path: string): Promise<readonly string[]> {
      const prefix = path.endsWith("/") ? path : `${path}/`;
      const names = new Set<string>();
      for (const key of files.keys()) {
        if (key.startsWith(prefix)) {
          const rest = key.slice(prefix.length).split("/")[0];
          if (rest !== undefined && rest !== "") names.add(rest);
        }
      }
      return Promise.resolve([...names]);
    },

    rmdir(path: string): Promise<void> {
      directories.delete(path);
      return Promise.resolve();
    },

    unlink(path: string): Promise<void> {
      files.delete(path);
      return Promise.resolve();
    },

    // Never exercised by the object-writing workload, but isomorphic-git binds them on
    // construction, so they must exist. Failing loudly beats silently returning something wrong.
    readlink(path: string): Promise<string> {
      return Promise.reject(enoent(path));
    },

    symlink(): Promise<void> {
      return Promise.reject(new Error("symlink is not supported by the in-memory test fs"));
    },
  };

  return {
    promises,
    paths: () => [...files.keys()],
    read: (path: string) => files.get(path)?.slice(),
  };
}
