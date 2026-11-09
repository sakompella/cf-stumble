import { createGitClient } from "@cloudflare/computer/git";
import { MemoryFs } from "./memory-fs.js";
import type { HistoryAppend } from "./log.js";

const HISTORY_REPOSITORY = "generations";

const TOKEN_SECONDS = 300;

const AUTHOR = { name: "cf-stumble Supervisor", email: "supervisor@cf-stumble.invalid" } as const;

type RepoGit = {
  init(options: { defaultBranch: string }): Promise<void>;
  clone(options: { url: string; headers: Record<string, string> }): Promise<void>;
  add(options: { paths: string[] }): Promise<void>;
  commit(options: { message: string; author: typeof AUTHOR }): Promise<void>;
  push(options: { url: string; ref: string; headers: Record<string, string> }): Promise<void>;
};

export type GitFactory = (fs: MemoryFs) => RepoGit;

type HistoryRepo = {
  info(): Promise<{ remote: string; lastPushAt: string | null }>;
  createToken(scope: "write", seconds: number): Promise<{ plaintext: string }>;
  [Symbol.dispose](): void;
};

export type HistoryBinding = {
  get(name: string): Promise<HistoryRepo>;
  create(
    name: string,
    options: { setDefaultBranch: string },
  ): Promise<{ remote: string; token: string }>;
};

type Access = Readonly<{ remote: string; secret: string; pushed: boolean }>;

const NO_WORKSPACE = {
  provider(): never {
    throw new Error("the history repository has no workspace");
  },
};

const memoryGit: GitFactory = (fs) => {
  const client = createGitClient({ adapter: () => Promise.resolve({ promises: fs.promises }) })({
    ws: NO_WORKSPACE,
  });

  return {
    async init(options) {
      await client.init(options);
    },
    async clone(options) {
      await client.clone(options);
    },
    async add(options) {
      await client.add(options);
    },
    async commit(options) {
      await client.commit(options);
    },
    async push(options) {
      await client.push(options);
    },
  };
};

function secretOf(plaintext: string): string {
  return plaintext.split("?")[0] ?? plaintext;
}

async function access(artifacts: HistoryBinding): Promise<Access> {
  const found = await artifacts.get(HISTORY_REPOSITORY).catch(() => null);

  if (found === null) {
    const created = await artifacts.create(HISTORY_REPOSITORY, { setDefaultBranch: "main" });

    return { remote: created.remote, secret: secretOf(created.token), pushed: false };
  }

  using repo = found;
  const info = await repo.info();
  const token = await repo.createToken("write", TOKEN_SECONDS);

  return {
    remote: info.remote,
    secret: secretOf(token.plaintext),
    pushed: info.lastPushAt !== null,
  };
}

export function artifactsHistory(
  artifacts: HistoryBinding,
  git: GitFactory = memoryGit,
): HistoryAppend {
  return async (commit) => {
    const { remote, secret, pushed } = await access(artifacts);
    const fs = new MemoryFs();
    const client = git(fs);
    const headers = { Authorization: `Bearer ${secret}` };

    if (pushed) await client.clone({ url: remote, headers });
    else await client.init({ defaultBranch: "main" });

    for (const [path, text] of Object.entries(commit.files)) fs.put(path, text);

    await client.add({ paths: Object.keys(commit.files) });
    await client.commit({ message: commit.message, author: AUTHOR });
    await client.push({ url: remote, ref: "main", headers });
  };
}
