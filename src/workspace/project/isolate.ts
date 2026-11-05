import type { WorkspaceBackend, WorkspaceOptions } from "@cloudflare/computer";
import { workspaceGit } from "./git-fs.js";
import { isolateShellBackend, type ShellHost } from "./isolate-shell.js";

type IsolateWorkspace = Readonly<{
  backend: WorkspaceBackend;
  git: NonNullable<WorkspaceOptions["git"]>;
}>;

export function isolateWorkspace(
  env: Readonly<{ LOADER: WorkerLoader; ASSETS: Fetcher }>,
  host: ShellHost,
): IsolateWorkspace {
  return { backend: isolateShellBackend(env.LOADER, env.ASSETS, host), git: workspaceGit };
}
