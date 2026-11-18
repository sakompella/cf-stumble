import {
  GitHubConnection,
  GitHubConnectionStore,
  ProjectConnections,
  type GitHubConnectionEnvironment,
} from "./projects/index.js";
import { Generations } from "./generations.js";
import { GenerationHistory } from "./generation-history.js";
import { FACET_COMPATIBILITY } from "../facet/index.js";
import type { GenerationOperations } from "../generation-requests.js";
import { ChatGPTConnection, ChatGPTCredentialStore } from "../chatgpt/index.js";
import { HarnessArtifacts, MainLineage } from "./artifacts/index.js";
import { ServingConversations } from "./conversations/index.js";
import { ProvisionFence, WorkspaceReadiness } from "./readiness/index.js";
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

  const fence = new ProvisionFence();

  const connections = new ProjectConnections({
    storage,
    workspaceName,
    fence,
    namespace: env.WORKSPACE_HOST,
    github,
  });

  const readiness = new WorkspaceReadiness({
    workspaceName,
    fence,
    namespace: env.WORKSPACE_HOST,
    generations,
    github,
    ensureProvisioned: (projectId) => connections.ensureProvisioned(projectId),
  });

  return { github, connections, readiness };
}

function chatgptConnection(storage: DurableObjectStorage, env: SupervisorEnv): ChatGPTConnection {
  return new ChatGPTConnection({
    store: new ChatGPTCredentialStore(storage),
    fetcher: (url, init) => fetch(url, init),
    model: env.CHATGPT_MODEL,
    clock: () => Date.now(),
  });
}

function generationHistory(ctx: DurableObjectState, env: SupervisorEnv): GenerationHistory {
  return new GenerationHistory(
    env.MODULE_MAPS,
    (pending) => {
      ctx.waitUntil(pending);
    },
    () => Date.now(),
  );
}

export function supervisorParts(
  ctx: DurableObjectState,
  env: SupervisorEnv,
  resetting: () => boolean,
  generationOperations: GenerationOperations,
) {
  const history = generationHistory(ctx, env);

  const generations = new Generations(ctx.storage, FACET_COMPATIBILITY, {
    changed: (change) => {
      history.record(change);
    },
    facetReplaced: () => {
      serving.replaceFacet();
    },
  });

  const { name, workspaceName } = supervisorNames(ctx);

  const artifacts = new HarnessArtifacts(env.MODULE_MAPS, () =>
    env.WORKSPACE_HOST.getByName(workspaceName),
  );

  const projects = projectParts(ctx.storage, env, workspaceName, generations);

  const serving = new ServingConversations({
    ctx,
    load: () => artifacts.load(generations.active()),
    start: (artifact) => artifacts.start(artifact, env.LOADER, ctx.facets),
    model: (instance) => ctx.exports.ModelRoute({ props: { supervisor: name, instance } }),
    catalog: () => projects.connections.catalog(),
    resetting,
    obtainWorkspace: (project, remainingMs) => projects.readiness.obtain(project, remainingMs),
    generations: generationOperations,
    selection: generations,
  });

  return {
    workspaceName,
    generations,
    lineage: new MainLineage(ctx.storage.kv, () => env.WORKSPACE_HOST.getByName(workspaceName)),
    startupCheckHost: {
      ctx,
      loader: env.LOADER,
      artifacts,
      generations,
      model: () => ctx.exports.StartupCheckModel({}),
      workspace: (remainingMs: number) => projects.readiness.obtain(null, remainingMs),
    },
    ...projects,
    serving,
    chatgpt: chatgptConnection(ctx.storage, env),
  };
}
