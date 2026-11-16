import { Buffer } from "node:buffer";
import type { SQLiteWorkspaceProvider } from "@cloudflare/computer";
import { createGitClient } from "@cloudflare/computer/git";

type ReadOptions = Parameters<SQLiteWorkspaceProvider["readFile"]>[1];

type WriteOptions = Parameters<SQLiteWorkspaceProvider["writeFile"]>[2];

export const workspaceGit = createGitClient({
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
