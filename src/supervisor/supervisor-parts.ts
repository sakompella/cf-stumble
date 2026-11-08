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
import { obtainProjectWorkspace, obtainScratchWorkspace } from "./obtain-workspace.js";
import { supervisorNames, type SupervisorEnv } from "./supervisor-env.js";

export type SupervisorParts = ReturnType<typeof supervisorParts>;

function projectParts(storage: DurableObjectStorage, env: SupervisorEnv, workspaceName: string) {
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

  return { github, connections };
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

  const { github, connections } = projectParts(ctx.storage, env, workspaceName);

  const sources = { workspaceName, namespace: env.WORKSPACE_HOST, generations, connections };

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
        obtainScratchWorkspace(sources, remainingMs, signal),
    },
    github,
    connections,
    serving: new ServingConversations({
      ctx,
      mount: (instance) =>
        Effect.fromResult(
          artifacts.mount(generations.active(), env.LOADER, ctx.facets, modelRoute(instance)),
        ),
      catalog: () => connections.catalog(),
      resetting,
      obtainWorkspace: (project, remainingMs, signal) =>
        obtainProjectWorkspace(sources, project, remainingMs, signal),
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
