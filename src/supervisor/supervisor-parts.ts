import * as Effect from "effect/Effect";
import {
  GitHubConnection,
  GitHubConnectionStore,
  ProjectConnections,
  type GitHubConnectionEnvironment,
} from "./projects/index.js";
import { Generations } from "./generations.js";
import { FACET_COMPATIBILITY } from "../facet/index.js";
import type { GenerationOperations } from "../generation-requests.js";
import { ChatGPTConnection, ChatGPTCredentialStore } from "../chatgpt/index.js";
import { HarnessArtifacts, type MainFacetCapabilities } from "./artifacts/index.js";
import { ServingConversations } from "./conversations/index.js";
import { WorkspaceReadiness } from "./readiness/index.js";
import { supervisorNames, type SupervisorEnv } from "./supervisor-env.js";

export type SupervisorParts = ReturnType<typeof supervisorParts>;

function projectParts(
  storage: DurableObjectStorage,
  env: SupervisorEnv,
  workspaceName: string,
  generations: Generations,
) {
  const environment: GitHubConnectionEnvironment = {
    clientId: env.GITHUB_OAUTH_CLIENT_ID,
    fallbackToken: env.GH_TOKEN,
    fetcher: (url, init) => fetch(url, init),
  };

  const github = new GitHubConnection({
    store: new GitHubConnectionStore(storage),
    workspaceName,
    namespace: env.WORKSPACE_HOST,
    environment,
  });

  const connections = new ProjectConnections({
    storage,
    workspaceName,
    namespace: env.WORKSPACE_HOST,
    github,
  });

  const readiness = new WorkspaceReadiness({
    workspaceName,
    namespace: env.WORKSPACE_HOST,
    generations,
    github,
    ensureProvisioned: (projectId, signal) => connections.ensureProvisioned(projectId, signal),
  });

  return { github, connections, readiness };
}

export function supervisorParts(
  ctx: DurableObjectState,
  env: SupervisorEnv,
  resetting: () => boolean,
  generationOperations: GenerationOperations,
) {
  const generations = new Generations(ctx.storage, FACET_COMPATIBILITY);
  const { name, workspaceName } = supervisorNames(ctx);

  const artifacts = new HarnessArtifacts(ctx.storage, () =>
    env.WORKSPACE_HOST.getByName(workspaceName),
  );

  const modelRoute = (instance: number): MainFacetCapabilities["MODEL"] =>
    ctx.exports.ModelRoute({ props: { supervisor: name, instance } });

  const projects = projectParts(ctx.storage, env, workspaceName, generations);

  return {
    workspaceName,
    generations,
    startupCheckHost: {
      ctx,
      loader: env.LOADER,
      artifacts,
      generations,
      model: () => ctx.exports.StartupCheckModel({}),
      workspace: (remainingMs: number, signal: AbortSignal) =>
        projects.readiness.obtain(null, remainingMs, signal),
    },
    ...projects,
    serving: new ServingConversations({
      ctx,
      mount: (instance) =>
        Effect.fromResult(
          artifacts.mount(generations.active(), env.LOADER, ctx.facets, modelRoute(instance)),
        ),
      catalog: () => projects.connections.catalog(),
      resetting,
      obtainWorkspace: (project, remainingMs, signal) =>
        projects.readiness.obtain(project, remainingMs, signal),
      generations: generationOperations,
      selection: generations,
    }),
    chatgpt: new ChatGPTConnection({
      store: new ChatGPTCredentialStore(ctx.storage),
      fetcher: (url, init) => fetch(url, init),
      model: env.CHATGPT_MODEL,
      clock: () => Date.now(),
    }),
  };
}
