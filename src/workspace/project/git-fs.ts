import { Buffer } from "node:buffer";
import type { SQLiteWorkspaceProvider } from "@cloudflare/computer";
import {
  createGitClient,
  type GitAuth,
  type GitCliInput,
  type GitCliResult,
  type GitClientFactory,
} from "@cloudflare/computer/git";
import { GITHUB_CLI_CONFIG_DIRECTORY } from "../../workspace-layout.js";
import { gitStatusText } from "./git-status-text.js";

type ReadOptions = Parameters<SQLiteWorkspaceProvider["readFile"]>[1];

type WriteOptions = Parameters<SQLiteWorkspaceProvider["writeFile"]>[2];

const sqliteGit = createGitClient({
  adapter: (provider) =>
    Promise.resolve({
      promises: {
        readFile: async (path: string, options?: ReadOptions) => {
          const result = await provider.readFile(path, options);

          return result;
        },
        writeFile: async (path: string, data: string | Uint8Array, options?: WriteOptions) => {
          await provider.writeFile(path, Buffer.from(data), options);
        },
        unlink: async (path: string) => {
          await provider.unlink(path);
        },
        readdir: async (path: string) => {
          const result = await provider.readdir(path);

          return result;
        },
        mkdir: async (path: string) => {
          const result = await provider.mkdir(path);

          return result;
        },
        rmdir: async (path: string) => {
          await provider.rmdir(path);
        },
        stat: async (path: string) => {
          const result = await provider.stat(path);

          return result;
        },
        lstat: async (path: string) => {
          const result = await provider.lstat(path);

          return result;
        },
        readlink: async (path: string) => {
          const result = await provider.readlink(path);

          return result;
        },
        symlink: async (target: string, path: string) => {
          await provider.symlink(target, path);
        },
      },
    }),
});

const TOKEN_LINE = /^\s*oauth_token:\s*(\S+)\s*$/mu;

export function githubTokenFromHosts(hosts: string): string | undefined {
  return TOKEN_LINE.exec(hosts)?.[1];
}

async function readHosts(provider: SQLiteWorkspaceProvider): Promise<string> {
  try {
    const hosts = await provider.readFile(`${GITHUB_CLI_CONFIG_DIRECTORY}/hosts.yml`);

    return hosts.toString();
  } catch {
    return "";
  }
}

async function githubAuth(provider: SQLiteWorkspaceProvider): Promise<GitAuth | undefined> {
  const token = githubTokenFromHosts(await readHosts(provider));

  return token === undefined ? undefined : { username: "x-access-token", password: token };
}

export const workspaceGit: GitClientFactory = (options) => {
  const client = sqliteGit(options);
  const onAuth = () => githubAuth(options.ws.provider());
  const fetch = client.fetch.bind(client);
  const push = client.push.bind(client);
  const pull = client.pull.bind(client);
  const cli = client.cli.bind(client);

  return Object.assign(client, {
    fetch: (input: Parameters<typeof fetch>[0]) => fetch({ onAuth, ...input }),
    push: (input: Parameters<typeof push>[0]) => push({ onAuth, ...input }),
    pull: (input: Parameters<typeof pull>[0]) => pull({ onAuth, ...input }),
    cli: (input: GitCliInput): Promise<GitCliResult> => {
      if (input.argv.length !== 1 || input.argv[0] !== "status") return cli(input);

      return gitStatusText(client, input.cwd ?? "/").then(
        (stdout) => ({ stdout, stderr: "", exitCode: 0 }),
        () => cli(input),
      );
    },
  });
};
