import { workspaceGit } from "./git-fs.js";
import { isolateShellBackend, type ShellHost } from "./isolate-shell.js";

export function isolateWorkspace(
  env: Readonly<{ LOADER: WorkerLoader; ASSETS: Fetcher }>,
  host: ShellHost,
) {
  return { backend: isolateShellBackend(env.LOADER, env.ASSETS, host), git: workspaceGit };
}
