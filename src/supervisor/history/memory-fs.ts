import { Buffer } from "node:buffer";

type Entry = { readonly data: Buffer | undefined };

const DIRECTORY_MODE = 0o040000;

const FILE_MODE = 0o100644;

function failure(code: string, path: string): Error {
  return Object.assign(new Error(`${code}: ${path}`), { code });
}

function parentOf(path: string): string {
  const cut = path.lastIndexOf("/");

  return cut <= 0 ? "/" : path.slice(0, cut);
}

function statsOf({ data }: Entry) {
  return {
    dev: 0,
    ino: 0,
    uid: 0,
    gid: 0,
    mode: data === undefined ? DIRECTORY_MODE : FILE_MODE,
    size: data?.byteLength ?? 0,
    ctimeMs: 0,
    mtimeMs: 0,
    isFile: () => data !== undefined,
    isDirectory: () => data === undefined,
    isSymbolicLink: () => false,
  };
}

export class MemoryFs {
  readonly #entries = new Map<string, Entry>([["/", { data: undefined }]]);

  readonly promises = {
    readFile: (path: string, options?: string | { readonly encoding?: string }) =>
      this.#run(() => {
        const { data } = this.#entry(path);

        if (data === undefined) throw failure("EISDIR", path);

        const text =
          options === "utf8" || (options instanceof Object && options.encoding === "utf8");

        return text ? data.toString("utf8") : data;
      }),
    writeFile: (path: string, data: string | Uint8Array) =>
      this.#run(() => {
        this.#write(path, data);
      }),
    unlink: (path: string) =>
      this.#run(() => {
        this.#remove(path);
      }),
    rmdir: (path: string) =>
      this.#run(() => {
        this.#remove(path);
      }),
    readdir: (path: string) => this.#run(() => this.#children(path)),
    mkdir: (path: string) =>
      this.#run(() => {
        this.#mkdir(path);
      }),
    stat: (path: string) => this.#run(() => statsOf(this.#entry(path))),
    lstat: (path: string) => this.#run(() => statsOf(this.#entry(path))),
    readlink: (path: string) => this.#run(() => failed("EINVAL", path)),
    symlink: (_target: string, path: string) => this.#run(() => failed("EPERM", path)),
  };

  put(path: string, text: string): void {
    const segments = path.split("/");

    for (let depth = 1; depth < segments.length; depth += 1) {
      const directory = `/${segments.slice(0, depth).join("/")}`;

      if (!this.#entries.has(directory)) this.#mkdir(directory);
    }

    this.#write(`/${path}`, text);
  }

  #run<Value>(action: () => Value): Promise<Value> {
    try {
      return Promise.resolve(action());
    } catch (cause) {
      return Promise.reject(cause instanceof Error ? cause : new Error(String(cause)));
    }
  }

  #entry(path: string): Entry {
    const entry = this.#entries.get(path);

    if (entry === undefined) throw failure("ENOENT", path);

    return entry;
  }

  #mkdir(path: string): void {
    if (this.#entries.has(path)) throw failure("EEXIST", path);

    this.#entry(parentOf(path));
    this.#entries.set(path, { data: undefined });
  }

  #write(path: string, data: string | Uint8Array): void {
    this.#entry(parentOf(path));
    this.#entries.set(path, { data: Buffer.from(data) });
  }

  #remove(path: string): void {
    this.#entry(path);
    this.#entries.delete(path);
  }

  #children(path: string): string[] {
    this.#entry(path);
    const prefix = path === "/" ? "/" : `${path}/`;

    return [...this.#entries.keys()]
      .flatMap((key) => {
        const name = key.slice(prefix.length);

        return key !== path && key.startsWith(prefix) && !name.includes("/") ? [name] : [];
      })
      .toSorted();
  }
}

function failed(code: string, path: string): never {
  throw failure(code, path);
}
