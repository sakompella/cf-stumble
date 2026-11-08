import type { Workspace } from "@cloudflare/computer";
import { Buffer } from "node:buffer";
import * as Effect from "effect/Effect";
import type { Project } from "../project-catalog.js";
import { attemptWorkspace, RepositoryNotEligible, type WorkspaceFault } from "./operations.js";
import { GITHUB_CLI_CONFIG_DIRECTORY, projectDirectory } from "../workspace-layout.js";

const ISOLATE_CLONE_DEPTH = 1;

const ISOLATE_CLONE_MAX_KB = 20_000;

const TOKEN_LINE = /^\s*oauth_token:\s*(\S+)\s*$/mu;

function githubToken(workspace: Workspace): Effect.Effect<string | undefined> {
  return Effect.tryPromise(() =>
    workspace.fs.readFile(`${GITHUB_CLI_CONFIG_DIRECTORY}/hosts.yml`, "utf8"),
  ).pipe(
    Effect.orElseSucceed(() => ""),
    Effect.map((hosts) => TOKEN_LINE.exec(hosts)?.[1]),
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

export function cloneProjectInIsolate(
  workspace: Workspace,
  project: Project,
): Effect.Effect<void, WorkspaceFault> {
  const root = projectDirectory(project.id);
  const staging = `${root}.provisioning`;

  const removeStaging = attemptWorkspace(() =>
    workspace.fs.rm(staging, { recursive: true, force: true }),
  );

  return Effect.gen(function* () {
    const token = yield* githubToken(workspace);

    yield* assertSmallRepository(project, token);
    yield* removeStaging;
    yield* attemptWorkspace(async () => {
      await workspace.git.clone({
        url: project.repositoryUrl,
        dir: staging,
        depth: ISOLATE_CLONE_DEPTH,
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
    }).pipe(Effect.tapError(() => removeStaging));
  });
}
