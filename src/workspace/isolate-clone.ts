import type { Workspace } from "@cloudflare/computer";
import { Buffer } from "node:buffer";
import type { Project } from "../project-catalog.js";
import { GITHUB_CLI_CONFIG_DIRECTORY, projectDirectory } from "../workspace-layout.js";

const ISOLATE_CLONE_DEPTH = 1;

const ISOLATE_CLONE_MAX_KB = 20_000;

const TOKEN_LINE = /^\s*oauth_token:\s*(\S+)\s*$/mu;

async function githubToken(workspace: Workspace): Promise<string | undefined> {
  const hosts = await workspace.fs
    .readFile(`${GITHUB_CLI_CONFIG_DIRECTORY}/hosts.yml`, "utf8")
    .catch(() => "");

  return TOKEN_LINE.exec(hosts)?.[1];
}

async function assertSmallRepository(project: Project, token: string | undefined): Promise<void> {
  const { pathname } = new URL(project.repositoryUrl);

  const headers = new Headers({
    accept: "application/vnd.github+json",
    "user-agent": "cf-stumble",
  });

  if (token !== undefined) headers.set("authorization", `Bearer ${token}`);

  const response = await fetch(`https://api.github.com/repos${pathname}`, { headers });

  const repository: { size?: number } = await response.json();

  if (!response.ok || repository.size === undefined || repository.size > ISOLATE_CLONE_MAX_KB)
    throw new Error(`repository is not eligible for an isolate clone (${String(response.status)})`);
}

export async function cloneProjectInIsolate(workspace: Workspace, project: Project): Promise<void> {
  const root = projectDirectory(project.id);
  const staging = `${root}.provisioning`;
  const token = await githubToken(workspace);

  await assertSmallRepository(project, token);
  await workspace.fs.rm(staging, { recursive: true, force: true });

  try {
    await workspace.git.clone({
      url: project.repositoryUrl,
      dir: staging,
      depth: ISOLATE_CLONE_DEPTH,
      headers:
        token === undefined
          ? {}
          : { Authorization: `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}` },
    });
    await workspace.git.configSet({ dir: staging, path: "core.fileMode", value: false });
    await workspace.fs.mkdir(root.slice(0, root.lastIndexOf("/")), { recursive: true });
    await workspace.fs.rename(staging, root);
  } catch (cause) {
    await workspace.fs.rm(staging, { recursive: true, force: true });
    throw cause;
  }
}
