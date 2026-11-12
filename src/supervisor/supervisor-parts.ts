import {
  GitHubConnection,
  GitHubConnectionStore,
  ProjectConnections,
  type GitHubConnectionEnvironment,
} from "./projects/index.js";
import { Generations } from "./generations.js";
import { generationHistory } from "./history/wiring.js";
import { FACET_COMPATIBILITY, type MainFacetModel } from "../facet/index.js";
import type { GenerationOperations } from "../generation-requests.js";
import { ChatGPTConnection, ChatGPTCredentialStore } from "../chatgpt/index.js";
import { HarnessArtifacts, OLD_PROTOCOL_COMPATIBILITY } from "./artifacts/index.js";
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

function servingMount(
  artifacts: HarnessArtifacts,
  generations: Generations,
  loader: WorkerLoader,
  facets: DurableObjectState["facets"],
  model: (instance: number) => MainFacetModel,
) {
  return (instance: number) =>
    artifacts.mount(
      generations.active(),
      loader,
      facets,
      generations.activeCompatibility() === OLD_PROTOCOL_COMPATIBILITY
        ? { instance, model: model(instance) }
        : undefined,
    );
}

export function supervisorParts(
  ctx: DurableObjectState,
  env: SupervisorEnv,
  resetting: () => boolean,
  generationOperations: GenerationOperations,
) {
  const history = generationHistory(ctx, env.MODULE_MAPS);

  const generations = new Generations(ctx.storage, FACET_COMPATIBILITY, (change) => {
    history.record(change);
  });

  const { name, workspaceName } = supervisorNames(ctx);

  const artifacts = new HarnessArtifacts(env.MODULE_MAPS, () =>
    env.WORKSPACE_HOST.getByName(workspaceName),
  );

  const model = (instance: number): MainFacetModel =>
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
      workspace: (remainingMs: number) => projects.readiness.obtain(null, remainingMs),
    },
    ...projects,
    serving: new ServingConversations({
      ctx,
      mount: servingMount(artifacts, generations, env.LOADER, ctx.facets, model),
      model,
      catalog: () => projects.connections.catalog(),
      resetting,
      obtainWorkspace: (project, remainingMs) => projects.readiness.obtain(project, remainingMs),
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
