import type { Workspace } from "@cloudflare/computer";
import { Buffer } from "node:buffer";
import * as Effect from "effect/Effect";
import type { Project } from "../project-catalog.js";
import { attemptWorkspace, RepositoryNotEligible, type WorkspaceFault } from "./operations.js";
import { GITHUB_CLI_CONFIG_DIRECTORY, projectDirectory } from "../workspace-layout.js";
import { githubTokenFromHosts } from "./project/index.js";

const ISOLATE_CLONE_DEPTH = 1;

const ISOLATE_CLONE_MAX_KB = 20_000;

export function githubToken(
  workspace: Readonly<{ fs: Pick<Workspace["fs"], "readFile"> }>,
): Effect.Effect<string | undefined> {
  return Effect.tryPromise(() =>
    workspace.fs.readFile(`${GITHUB_CLI_CONFIG_DIRECTORY}/hosts.yml`, "utf8"),
  ).pipe(
    Effect.orElseSucceed(() => ""),
    Effect.map(githubTokenFromHosts),
  );
}

function assertSmallRepository(
  project: Project,
  token: string | undefined,
): Effect.Effect<void, WorkspaceFault> {
  return Effect.gen(function* () {
    const { pathname } = new URL(project.repositoryUrl);

    const headers = new Headers({
      accept: "application/vnd.github+json",
      "user-agent": "cf-stumble",
    });

    if (token !== undefined) headers.set("authorization", `Bearer ${token}`);

    const response = yield* attemptWorkspace(() =>
      fetch(`https://api.github.com/repos${pathname}`, { headers }),
    );

    const repository: { size?: number } = yield* attemptWorkspace<{ size?: number }>(() =>
      response.json(),
    );

    if (!response.ok || repository.size === undefined || repository.size > ISOLATE_CLONE_MAX_KB) {
      yield* Effect.fail(
        new RepositoryNotEligible({
          message: `repository is not eligible for an isolate clone (${String(response.status)})`,
        }),
      );
    }
  });
}

export function cloneIntoPlace(
  workspace: Readonly<{
    fs: Pick<Workspace["fs"], "rm" | "mkdir" | "rename">;
    git: Pick<Workspace["git"], "clone" | "configSet">;
  }>,
  clone: Readonly<{ url: string; root: string; depth: number; token: string | undefined }>,
): Effect.Effect<void, WorkspaceFault> {
  const { root, token } = clone;
  const staging = `${root}.provisioning`;

  const removeStaging = attemptWorkspace(() =>
    workspace.fs.rm(staging, { recursive: true, force: true }),
  );

  return removeStaging.pipe(
    Effect.andThen(
      attemptWorkspace(async () => {
        await workspace.git.clone({
          url: clone.url,
          dir: staging,
          depth: clone.depth,
          headers:
            token === undefined
              ? {}
              : {
                  Authorization: `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
                },
        });
        await workspace.git.configSet({ dir: staging, path: "core.fileMode", value: false });
        await workspace.fs.mkdir(root.slice(0, root.lastIndexOf("/")), { recursive: true });
        await workspace.fs.rename(staging, root);
      }),
    ),
    Effect.tapError(() => removeStaging),
  );
}

export function cloneProjectInIsolate(
  workspace: Workspace,
  project: Project,
): Effect.Effect<void, WorkspaceFault> {
  return Effect.gen(function* () {
    const token = yield* githubToken(workspace);

    yield* assertSmallRepository(project, token);
    yield* cloneIntoPlace(workspace, {
      url: project.repositoryUrl,
      root: projectDirectory(project.id),
      depth: ISOLATE_CLONE_DEPTH,
      token,
    });
  });
}
