// oxlint-disable max-lines -- One Durable Object class is one RPC surface: the runtime exposes the
// methods declared here, so moving a group of them into another file would either hide them from
// the binding or add a second object to route through. Each method below delegates to the module
// that owns the work.

// oxlint-disable import/max-dependencies -- The Supervisor is where every group meets, so it imports each of them.

import { DurableObject } from "cloudflare:workers";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { isTimeoutFailure, logRedactedCause } from "../diagnostics.js";
import {
  GenerationControl,
  type GenerationControlResult,
  type GenerationCommand,
} from "./control/index.js";
import {
  GitHubConnection,
  GitHubConnectionStore,
  ProjectConnections,
  runProjectTurn,
  startFacetTurn,
  type FacetTurnHandoff,
  type ConnectRepositoryResult,
  type DisconnectRepositoryResult,
  type CredentialWorkspaceNamespace,
  type ProvisionWorkspaceNamespace,
  type ProjectRemovalWorkspaceNamespace,
  type GitHubAuthorizationOutcome,
  type GitHubConnectionEnvironment,
  type GitHubConnectionRecord,
  type ProjectTurnRun,
  type ProjectTurnStart,
  type ProjectWorkspaceNamespace,
  type TurnStartContext,
} from "./projects/index.js";
import { Generations, type ActiveGeneration } from "./generations/index.js";
import { runAtEntryPoint } from "../run-entry-point.js";
import {
  ChatGPTConnection,
  ChatGPTCredentialStore,
  type ChatGPTAccess,
  type ChatGPTConnectionView,
  type ChatGPTLoginOutcome,
} from "../chatgpt/index.js";
import { PROJECT_TURN_DEADLINE_MS, PROJECT_TURN_LEASE_MS } from "../turn-budget.js";
import type { SelectableCatalog } from "../selectable-projects.js";
import { tenantWorkspaceName } from "../workspace-names.js";
import { ProjectThreads, type LiveTurn, type ProjectThreadResult } from "./threads/index.js";
import {
  HarnessArtifacts,
  type BuildWorkspaceNamespace,
  type MainFacetCapabilities,
} from "./artifacts/index.js";
import type {
  HarnessProvisionWorkspaceNamespace,
  WorkspaceResetResult,
} from "../workspace/index.js";
import {
  checkGenerationStartup,
  type StartupCheckHost,
  type StartupCheckOptions,
  type StartupCheckResult,
} from "./startup-check/index.js";

type ResetWorkspaceNamespace = Readonly<{
  getByName(name: string): Readonly<{ reset(): Promise<WorkspaceResetResult> }>;
}>;

export type SupervisorWorkspaceReset =
  | WorkspaceResetResult
  | Readonly<{ ok: false; problem: Readonly<{ code: "turn-active" } & LiveTurn> }>;

const WORKSPACE_BUSY = { ok: false, problem: { code: "workspace-busy" } } as const;

type SupervisorEnv = {
  readonly LOADER: WorkerLoader;
  readonly WORKSPACE_HOST: BuildWorkspaceNamespace &
    ProjectWorkspaceNamespace &
    CredentialWorkspaceNamespace &
    ProvisionWorkspaceNamespace &
    ProjectRemovalWorkspaceNamespace &
    HarnessProvisionWorkspaceNamespace &
    ResetWorkspaceNamespace;
  /** Public configuration, not a secret. */
  readonly GITHUB_OAUTH_CLIENT_ID?: string;
  readonly GH_TOKEN?: string;
  readonly CHATGPT_MODEL: string;
};

function reachedName(ctx: DurableObjectState): string {
  const name = ctx.id.name;

  if (name === undefined) throw new Error("a Supervisor must be reached by name, not by id");

  return name;
}

export class Supervisor extends DurableObject<SupervisorEnv> {
  private readonly control: GenerationControl;
  private readonly generations: Generations;
  private readonly artifacts: HarnessArtifacts;
  private readonly startupCheckHost: StartupCheckHost;
  private readonly threads: ProjectThreads;
  private readonly github: GitHubConnection;
  private readonly connections: ProjectConnections;
  private readonly chatgpt: ChatGPTConnection;
  private readonly workspaceName: string;
  private readonly name: string;
  /** Fences leases held by an instance Durable Objects have since replaced. */
  private readonly instanceId = crypto.randomUUID();
  /** Set from an owner reset's arrival until it ends. Turn admission, connect, disconnect and another reset refuse meanwhile. */
  #resetInProgress = false;

  constructor(ctx: DurableObjectState, env: SupervisorEnv) {
    super(ctx, env);
    this.generations = new Generations(ctx.storage);
    this.name = reachedName(ctx);
    this.workspaceName = tenantWorkspaceName(this.name);
    this.artifacts = HarnessArtifacts.forWorkspace(
      ctx.storage,
      env.WORKSPACE_HOST,
      this.workspaceName,
    );
    this.startupCheckHost = {
      ctx,
      loader: env.LOADER,
      artifacts: this.artifacts,
      generations: this.generations,
      modelRoute: () => this.#modelRoute(),
    };
    this.control = new GenerationControl(this.generations);

    const environment: GitHubConnectionEnvironment = {
      clientId: env.GITHUB_OAUTH_CLIENT_ID,
      fallbackToken: env.GH_TOKEN,
      fetcher: (url, init) => fetch(url, init),
    };

    this.github = new GitHubConnection({
      store: new GitHubConnectionStore(ctx.storage),
      workspaceName: this.workspaceName,
      namespace: env.WORKSPACE_HOST,
      environment,
    });
    this.connections = new ProjectConnections({
      storage: ctx.storage,
      workspaceName: this.workspaceName,
      namespace: env.WORKSPACE_HOST,
      environment,
      github: this.github,
    });
    // Read at each call so a repository connected a moment ago resolves without restarting this object.
    this.threads = new ProjectThreads(
      ctx.storage,
      () => this.connections.catalog(),
      this.instanceId,
    );
    this.chatgpt = new ChatGPTConnection({
      store: new ChatGPTCredentialStore(ctx.storage),
      fetcher: (url, init) => fetch(url, init),
      model: env.CHATGPT_MODEL,
      clock: () => Date.now(),
    });
  }

  #modelRoute(): MainFacetCapabilities["MODEL"] {
    return this.ctx.exports.ModelRoute({ props: { supervisor: this.name } });
  }

  #mountServing(active: ActiveGeneration) {
    return this.artifacts.mount(active, this.env.LOADER, this.ctx.facets, this.#modelRoute());
  }

  prepareGeneration(label: number, options?: StartupCheckOptions): Promise<StartupCheckResult> {
    return runAtEntryPoint(checkGenerationStartup(this.startupCheckHost, label, options));
  }

  getActiveGeneration(): ActiveGeneration {
    return this.generations.active();
  }

  controlGeneration(command: GenerationCommand): GenerationControlResult {
    return this.control.execute(command);
  }

  /** The harness entry has no repository URL, which tells the sidebar it is not a connection. */
  listProjects(): SelectableCatalog {
    return this.connections.catalog();
  }

  /** Reads this object's storage only, so a client polling it cannot keep the workspace container running. */
  getGitHubConnection(now: number = Date.now()): GitHubConnectionRecord {
    return this.github.lastKnown(now);
  }

  /** Installs `GH_TOKEN` when the workspace has no usable credential. Reaches the Workspace Host. */
  refreshGitHubConnection(now: number = Date.now()): Promise<GitHubConnectionRecord> {
    return runAtEntryPoint(
      this.github.ensureCredential(now).pipe(Effect.map(() => this.github.lastKnown(now))),
    );
  }

  /**
   * A live turn lease refuses the reset: it deletes the turn's files and restarts its container. The
   * exclusion is set before the lease check in the same synchronous step, so no turn is admitted
   * between the check and the end of the reset.
   */
  async resetWorkspace(now: number = Date.now()): Promise<SupervisorWorkspaceReset> {
    if (this.#resetInProgress) return WORKSPACE_BUSY;

    this.#resetInProgress = true;

    try {
      const liveTurn = this.threads.liveTurn(now);

      if (liveTurn !== undefined) {
        return { ok: false, problem: { code: "turn-active", ...liveTurn } };
      }

      const namespace: ResetWorkspaceNamespace = this.env.WORKSPACE_HOST;

      const result = await namespace.getByName(this.workspaceName).reset();

      if (result.ok) this.connections.resetWorkspace();

      return result;
    } finally {
      this.#resetInProgress = false;
    }
  }

  /** The repository URL is canonicalized and the project id derived from it, so connecting a repository twice converges on one project. */
  connectProject(
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Boundary: Durable Object RPC input is untrusted.
    repositoryUrl: unknown,
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Boundary: see above.
    displayName: unknown,
    now: number = Date.now(),
  ): Promise<ConnectRepositoryResult> {
    if (this.#resetInProgress) {
      return Promise.resolve({ ok: false, problem: { code: "workspace-busy", detail: "" } });
    }

    return runAtEntryPoint(this.connections.connect(repositoryUrl, displayName, now));
  }

  disconnectProject(
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Durable Object RPC input is untrusted.
    projectId: unknown,
    now: number = Date.now(),
  ): Promise<DisconnectRepositoryResult> {
    if (this.#resetInProgress) return Promise.resolve(WORKSPACE_BUSY);

    return runAtEntryPoint(
      this.connections.disconnect(projectId, () => this.threads.disconnectProject(projectId, now)),
    );
  }

  /** A second redemption of a consumed code is refused. */
  startGitHubAuthorization(now: number = Date.now()): Promise<GitHubAuthorizationOutcome> {
    return runAtEntryPoint(this.github.startAuthorization(now));
  }

  completeGitHubAuthorization(now: number = Date.now()): Promise<GitHubAuthorizationOutcome> {
    return runAtEntryPoint(this.github.completeAuthorization(now));
  }

  getChatGPTConnection(): ChatGPTConnectionView {
    return this.chatgpt.view();
  }

  startChatGPTLogin(): Promise<ChatGPTConnectionView> {
    return runAtEntryPoint(this.chatgpt.startLogin());
  }

  completeChatGPTLogin(
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Boundary: Durable Object RPC input is untrusted.
    attemptId: unknown,
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Boundary: see above.
    callbackUrl: unknown,
  ): Promise<ChatGPTLoginOutcome> {
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Boundary: untrusted RPC arguments.
    if (typeof attemptId !== "string" || typeof callbackUrl !== "string") {
      return Promise.resolve({
        ok: false,
        problem: { code: "no-sign-in" },
        chatgpt: this.chatgpt.view(),
      });
    }

    return runAtEntryPoint(this.chatgpt.completeLogin(attemptId, callbackUrl));
  }

  disconnectChatGPT(): ChatGPTConnectionView {
    return this.chatgpt.disconnect();
  }

  /** Only the model route calls this: the owner API exposes no route to it, and a facet holds no Supervisor stub. */
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Boundary: Durable Object RPC input is untrusted.
  chatgptAccess(rejected?: unknown): Promise<ChatGPTAccess> {
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Boundary: untrusted RPC argument.
    const refused = typeof rejected === "string" ? rejected : undefined;

    return runAtEntryPoint(this.chatgpt.access(refused));
  }

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Boundary: Durable Object RPC input is untrusted.
  markChatGPTRefused(accessToken: unknown): void {
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Boundary: untrusted RPC argument.
    if (typeof accessToken === "string") this.chatgpt.markRefused(accessToken);
  }

  markChatGPTUsageLimited(
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Boundary: Durable Object RPC input is untrusted.
    accessToken: unknown,
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Boundary: Durable Object RPC input is untrusted.
    limitedUntil: unknown,
  ): void {
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Boundary: untrusted RPC argument.
    if (typeof accessToken !== "string") return;

    this.chatgpt.markUsageLimited(
      accessToken,
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Boundary: untrusted RPC argument.
      typeof limitedUntil === "number" && Number.isFinite(limitedUntil) ? limitedUntil : null,
    );
  }

  /** Each method resolves the client's project id against the catalog before any row is touched, so the server names the thread. */
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Boundary: Durable Object RPC input is untrusted; `ProjectThreads` resolves it.
  getProjectThread(projectId: unknown): ProjectThreadResult {
    return this.threads.read(projectId);
  }

  startFreshProjectThread(
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Boundary: see `getProjectThread`.
    projectId: unknown,
    now: number = Date.now(),
  ): ProjectThreadResult {
    return this.threads.startFreshThread(projectId, now);
  }

  /**
   * A client sends only a project id and a prompt: tenant, conversation, model and lease id are all
   * server-side, and the lease id never leaves. A browser that could hold a lease could finish a turn it did not run.
   */
  runProjectTurn(
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Boundary: see `getProjectThread`.
    projectId: unknown,
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Boundary: the prompt is client text; `runProjectTurn` validates it.
    prompt: unknown,
  ): Promise<ProjectTurnRun> {
    return runAtEntryPoint(
      runProjectTurn({
        projectId,
        prompt,
        threads: this.threads,
        resetting: () => this.#resetInProgress,
        attribution: () => ({ active: this.generations.active() }),
        start: (project, request, context) => this.#startTurnStream(project, request, context),
        now: () => Date.now(),
        leaseMs: PROJECT_TURN_LEASE_MS,
        deadlineMs: PROJECT_TURN_DEADLINE_MS,
      }),
    );
  }

  #startTurnStream(
    projectId: string,
    request: FacetTurnHandoff,
    context: TurnStartContext,
  ): Effect.Effect<ProjectTurnStart> {
    const generation = context.attribution.active.generation;

    return startFacetTurn({
      projectId,
      request,
      catalog: this.connections.catalog(),
      workspaceName: this.workspaceName,
      namespace: this.env.WORKSPACE_HOST,
      signal: context.signal,
      remainingMs: context.remainingMs,
      // The generation admission snapshotted, not the active one.
      mount: () =>
        Effect.suspend(() => Effect.fromResult(this.#mountServing(context.attribution.active))),
      // Reconcile the harness checkout before mounting so a reset cannot leave Computer without a working directory.
      provisionHarness:
        generation === undefined
          ? undefined
          : (signal) => this.connections.ensureHarnessProvisioned(generation.harnessCommit, signal),
      // Provisioning runs per turn too: the workspace can be recreated between turns.
      provision: (project, signal) =>
        this.connections.ensureProvisioned(project.id, signal).pipe(Effect.map((used) => used.ok)),
    });
  }

  /** No active generation answers 503, since there is nothing to serve until a harness commit is activated. Any other mount failure answers 500. */
  override fetch(request: Request): Promise<Response> {
    const mainFacet = this.#mountServing(this.generations.active());

    if (Result.isFailure(mainFacet)) {
      const { code } = mainFacet.failure;

      return Promise.resolve(
        code === "no-active-generation"
          ? Response.json({ ok: false, problem: { code } }, { status: 503 })
          : new Response("Cannot mount main facet", { status: 500 }),
      );
    }

    return forwardToFacet(request, mainFacet.success.fetcher);
  }
}

export async function forwardToFacet(
  request: Request,
  fetcher: Pick<Fetcher, "fetch">,
): Promise<Response> {
  try {
    return await fetcher.fetch(request);
  } catch (cause) {
    // The caller sees only the generic 502 so a broken generation and a Loader or RPC failure look identical.
    // The discarded cause is logged redacted for operators.
    logRedactedCause(
      `supervisor.relay.forward ${request.method} ${new URL(request.url).pathname}: ${
        isTimeoutFailure(cause) ? "timeout" : "main-facet-failed-before-headers"
      }`,
      cause,
    );

    return new Response("Main facet failed before response headers", { status: 502 });
  }
}
