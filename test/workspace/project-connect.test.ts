import type { ExecSyncResult } from "@cloudflare/computer";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, expect, test, vi } from "vitest";
import { projectDirectory } from "../../src/workspace-layout.js";
import { WorkspaceHost } from "../../src/workspace/host.js";
import { sampleProjectOne } from "../project-fixtures.js";
import { restoreWorkspaceMembers, stubWorkspaceMember } from "./host-fixtures.js";

afterEach(() => {
  restoreWorkspaceMembers();
  vi.restoreAllMocks();
});

const project = sampleProjectOne;

const request = {
  kind: "provision-project",
  projectId: project.id,
  repositoryUrl: project.repositoryUrl,
} as const;

const complete: ExecSyncResult = { status: "complete", applied: 1, skipped: [] };

type Connect = Readonly<{
  answer: unknown;
  containerScripts: readonly string[];
  hostGit: readonly string[];
  githubRequests: readonly string[];
}>;

function notFound(): Promise<never> {
  return Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
}

function stubFilesystem(state: { cloned: boolean }): void {
  stubWorkspaceMember("fs", {
    lstat: (path: string) =>
      state.cloned
        ? Promise.resolve({ isSymbolicLink: false, isDirectory: !path.endsWith("/.git/config") })
        : notFound(),
    readFile: (path: string) =>
      state.cloned && path === `${projectDirectory(project.id)}/.git/config`
        ? Promise.resolve(`[remote "origin"]\n\turl = ${project.repositoryUrl}\n`)
        : notFound(),
    rm: () => Promise.resolve(),
    mkdir: () => Promise.resolve(),
    rename: () => {
      state.cloned = true;

      return Promise.resolve();
    },
  });
}

function stubHostGit(calls: string[]): void {
  stubWorkspaceMember(
    "git",
    new Proxy(
      {},
      {
        get: (_target, method) => () => {
          calls.push(String(method));

          return Promise.resolve();
        },
      },
    ),
  );
}

function connect(name: string, container: { exitCode: number; stdout: string }): Promise<Connect> {
  const state = { cloned: false };
  const containerScripts: string[] = [];
  const hostGit: string[] = [];
  const githubRequests: string[] = [];

  vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
    githubRequests.push(input instanceof Request ? input.url : String(input));

    return Promise.resolve(Response.json({ size: 150 }));
  });

  stubFilesystem(state);
  stubHostGit(hostGit);
  stubWorkspaceMember("runtime", {
    exec: (source: string) => {
      containerScripts.push(source);
      state.cloned = container.exitCode === 0;

      return Promise.resolve({
        result: () => Promise.resolve({ stderr: "", sync: complete, ...container }),
      });
    },
  });

  return runInDurableObject(env.SUPERVISOR.getByName(name), async (_instance, durable) => {
    Object.defineProperty(durable, "container", { value: {}, configurable: true });

    const host = new WorkspaceHost(durable, { LOADER: env.LOADER, ASSETS: env.ASSETS });

    return { answer: await host.provision(request), containerScripts, hostGit, githubRequests };
  });
}

test("connecting a project runs no Git on the Workspace Host", async () => {
  const connected = await connect("connect-no-host-git", { exitCode: 0, stdout: "" });

  expect(connected.answer).toEqual({ ok: true });
  expect(connected.hostGit).toEqual([]);
  expect(connected.githubRequests, "the Host measures nothing; the container does").toEqual([]);
  expect(connected.containerScripts).toHaveLength(1);
});

test("a project that GitHub reports as a small pack is still refused when the container counts too many files", async () => {
  const connected = await connect("connect-many-small-files", {
    exitCode: 122,
    stdout: "size-verdict=too-many-files\n",
  });

  expect(connected.answer).toEqual({
    ok: false,
    error: { code: "repository-too-large", verdict: "too-many-files" },
  });
  expect(connected.hostGit).toEqual([]);
});
