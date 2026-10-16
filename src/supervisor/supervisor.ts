// oxlint-disable max-lines -- One Durable Object class is one RPC surface: the runtime exposes the
// methods declared here, so moving a group of them into another file would either hide them from
// the binding or add a second object to route through. Each method below delegates to the module
// that owns the work.

// oxlint-disable import/max-dependencies -- The Supervisor is where every group meets, so it imports each of them.

import { DurableObject } from "cloudflare:workers";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import {
  isTimeoutFailure,
  logRedactedCause,
  parseRequestId,
  timedWorkspaceRpc,
} from "../diagnostics.js";
import {
  GenerationControl,
  type GenerationControlResult,
  type GenerationRequest,
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
  type VerifiedAccessScope,
  type GitHubAuthorizationOutcome,
  type GitHubConnectionEnvironment,
  type GitHubConnectionStatus,
  type ProjectListView,
  type ProjectTurnRun,
  type ProjectTurnStart,
  type ProjectWorkspaceNamespace,
  type TurnStartContext,
  timedTurnMount,
  timedTurnProvision,
} from "./projects/index.js";
import {
  Generations,
  parseGenerationLabel,
  type ActiveGeneration,
  type Generation,
  type PreparationCheck,
} from "./generations/index.js";
import { runAtEntryPoint } from "../run-entry-point.js";
import {
  ChatGPTConnection,
  ChatGPTCredentialStore,
  type ChatGPTAccess,
  type ChatGPTConnectionView,
  type ChatGPTLoginOutcome,
} from "../chatgpt/index.js";
import { PROJECT_TURN_DEADLINE_MS, PROJECT_TURN_LEASE_MS } from "../turn-budget.js";
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

// `WORKSPACE_HOST` is one namespace, seen through narrow views of the tenant's one shared
// workspace (ADR-0038). No view can perform another's operations.
/** The owner reset view: wipe one tenant workspace (see `WorkspaceHost.reset`). */
type ResetWorkspaceNamespace = Readonly<{
  getByName(name: string): Readonly<{ reset(): Promise<WorkspaceResetResult> }>;
}>;

/**
 * A reset the Supervisor refused, because a turn holds a lease, or what the Host answered. A reset
 * that arrives while another runs is refused `workspace-busy`, the Host's own answer for it.
 */
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
  /** The GitHub OAuth app the device flow belongs to. Public configuration, not a secret. */
  readonly GITHUB_OAUTH_CLIENT_ID?: string;
  /** The documented test and development credential source. See `docs/agents/design/github-connection.md`. */
  readonly GH_TOKEN?: string;
  /** The model ChatGPT turns use. A declared plain variable, not a secret. */
  readonly CHATGPT_MODEL: string;
};

/**
 * The name the Worker reached this Supervisor by, which it derived from the verified owner. A
 * Supervisor reached by raw id has no verified tenant behind it, and its one workspace is named from
 * this name. Falling back to the id would mint a valid workspace name for a request that never
 * proved whose workspace it is.
 */
function verifiedName(ctx: DurableObjectState): string {
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
  /** The workspace's GitHub credential and the device authorization that installs it. */
  private readonly github: GitHubConnection;
  /** The tenant's connected repositories and their provisioning. */
  private readonly connections: ProjectConnections;
  /** The owner's ChatGPT credential, which the model route uses (ADR-0047). */
  private readonly chatgpt: ChatGPTConnection;
  /** The tenant's one workspace, named from this object's own name (`workspace-names.ts`). */
  private readonly workspaceName: string;
  /** This object's name, which the Worker derived from the verified owner. */
  private readonly name: string;
  /** Fences leases held by an instance that Durable Objects have since replaced. */
  private readonly instanceId = crypto.randomUUID();
  /**
   * Set from the moment an owner reset arrives until it ends. Turn admission, connect, disconnect,
   * and another reset refuse while it is set. The Workspace Host keeps its own exclusion.
   */
  #resetInProgress = false;

  constructor(ctx: DurableObjectState, env: SupervisorEnv) {
    super(ctx, env);
    this.generations = new Generations(ctx.storage);
    this.name = verifiedName(ctx);
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
    // One catalog reaches the thread surface and the turn path, read at each call so a repository
    // connected a moment ago resolves without restarting this object.
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

  /** The route is told which Supervisor holds the credential; the facet only holds the stub. */
  #modelRoute(): MainFacetCapabilities["MODEL"] {
    return this.ctx.exports.ModelRoute({ props: { supervisor: this.name } });
  }

  /** Mount one generation as a facet. Relaying and starting a project turn both use this. */
  #mountServing(active: ActiveGeneration) {
    return this.artifacts.mount(active, this.env.LOADER, this.ctx.facets, this.#modelRoute());
  }

  /**
   * Prepare a labeled generation from its harness commit: read the stored module map or build the
   * commit and store it, then run the bounded startup check. This never changes the active
   * generation.
   */
  prepareGeneration(label: number, options?: StartupCheckOptions): Promise<StartupCheckResult> {
    return runAtEntryPoint(checkGenerationStartup(this.startupCheckHost, label, options));
  }

  getActiveGeneration(): ActiveGeneration {
    return this.generations.active();
  }

  getGeneration(label: number): Generation | undefined {
    const generationLabel = parseGenerationLabel(label);

    return generationLabel === undefined ? undefined : this.generations.byLabel(generationLabel);
  }

  getGenerations(): readonly Generation[] {
    return this.generations.all();
  }

  controlGeneration(request: GenerationRequest): GenerationControlResult {
    return this.control.execute(request);
  }

  getPreparationCheckHistory(label: number): readonly PreparationCheck[] {
    const generationLabel = parseGenerationLabel(label);

    return generationLabel === undefined
      ? []
      : this.generations.preparationCheckHistory(generationLabel);
  }

  /**
   * The tenant's connected repositories, with a GitHub connection status that carries no
   * credential. This is what the page's project sidebar reads.
   */
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Durable Object RPC input is untrusted; parseRequestId drops anything but a UUID.
  listProjects(requestId?: unknown, now: number = Date.now()): Promise<ProjectListView> {
    return runAtEntryPoint(this.connections.list(now, parseRequestId(requestId)));
  }

  getGitHubConnection(
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Durable Object RPC input is untrusted; parseRequestId drops anything but a UUID.
    requestId?: unknown,
    now: number = Date.now(),
  ): Promise<GitHubConnectionStatus> {
    return runAtEntryPoint(this.connections.connectionStatus(now, parseRequestId(requestId)));
  }

  /**
   * Reset only the shared workspace; project threads and generation state live elsewhere here.
   *
   * A live turn lease on any project or the harness refuses the reset. The reset deletes the files
   * the turn works in and restarts the container its commands run in, so it would cut the turn off
   * halfway through a change. The Workspace Host refuses in turn while it runs a file change or a
   * credential install.
   *
   * The exclusion is set before the lease check, in the same synchronous step, so no turn can be
   * admitted between the check and the end of the reset.
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

      const result = await timedWorkspaceRpc(
        { method: "reset" },
        () => namespace.getByName(this.workspaceName).reset(),
        (reset) =>
          reset.ok ? { outcome: "reset" } : { outcome: reset.problem.code, level: "warn" },
      );

      if (result.ok) this.connections.resetWorkspace();

      return result;
    } finally {
      this.#resetInProgress = false;
    }
  }

  /**
   * Connect one GitHub repository to this tenant: make the workspace's credential usable, check
   * that the repository is readable through ordinary Git, then store and provision it.
   *
   * Neither argument names a tenant, a workspace, or a path. The repository URL is canonicalized
   * and the project id derived from it, so connecting the same repository twice converges on the
   * project that is already there.
   */
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

  /** Disconnect a connected repository after its thread confirms no live turn owns it. */
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

  /**
   * Start and finish the GitHub device authorization (ADR-0039). The scope is the one the Access
   * check verified at the boundary, and the authorization is bound to it: a redemption presented by a
   * different verified owner, or a second redemption of a consumed code, is refused.
   */
  startGitHubAuthorization(
    scope: VerifiedAccessScope,
    now: number = Date.now(),
  ): Promise<GitHubAuthorizationOutcome> {
    return runAtEntryPoint(this.github.startAuthorization(scope, now));
  }

  completeGitHubAuthorization(
    scope: VerifiedAccessScope,
    now: number = Date.now(),
  ): Promise<GitHubAuthorizationOutcome> {
    return runAtEntryPoint(this.github.completeAuthorization(scope, now));
  }

  /** The ChatGPT connection as the owner sees it. It carries no token. */
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

  /**
   * The access token for the model route's next ChatGPT call, refreshed first when it is close to
   * expiry. Only the model route calls this: the owner API exposes no route to it, and a facet
   * holds no Supervisor stub.
   */
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

  /** The model route met the plan's usage limit; `limitedUntil` is when it ends, if OpenAI said. */
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Boundary: Durable Object RPC input is untrusted.
  markChatGPTUsageLimited(limitedUntil: unknown): void {
    this.chatgpt.markUsageLimited(
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Boundary: untrusted RPC argument.
      typeof limitedUntil === "number" && Number.isFinite(limitedUntil) ? limitedUntil : null,
    );
  }

  /**
   * The project thread surface. Each method takes the project id a client sent and resolves it
   * against the catalog before any row is touched (ADR-0038), so the thread a request reaches is
   * named by the server.
   */
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Boundary: Durable Object RPC input is untrusted; `ProjectThreads` resolves it.
  getProjectThread(projectId: unknown): ProjectThreadResult {
    return this.threads.read(projectId);
  }

  /** Refused with `turn-active` while a turn holds the project's lease (`ThreadStore`). */
  startFreshProjectThread(
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Boundary: see `getProjectThread`.
    projectId: unknown,
    now: number = Date.now(),
  ): ProjectThreadResult {
    return this.threads.startFreshThread(projectId, now);
  }

  /**
   * Run one authenticated project turn and stream it: admit the turn, run it on the generation
   * that serves, and save what Pi ended with — all on this side of the boundary.
   *
   * A client sends a project id and a prompt. It cannot send a tenant, a conversation, a model,
   * or a lease: the tenant is this object, the conversation is the thread this object saved, the
   * model is the route the generation was mounted with, and the lease id is minted at admission
   * and never leaves. That is why the three lease methods and the bare streaming method this
   * replaced are gone; a browser that could hold a lease could also finish a turn it did not run.
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

  /**
   * Run one turn in the tenant's workspace, in the selected project's directory, and stream it.
   *
   * The capability and the selected project's working directory both travel to the generation as
   * arguments of its `startTurn`; nothing here is reachable from a request.
   */
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
      // The generation admission snapshotted, not the one that is active now: the turn is mounted
      // on the same generation it was admitted against (`turn-run.ts`).
      mount: () =>
        Effect.suspend(() =>
          Effect.fromResult(this.#mountServing(context.attribution.active)),
        ).pipe(timedTurnMount(context.trace)),
      // The harness checkout is owned by the active generation's repository. Reconcile it before
      // mounting so a reset cannot leave Computer with a missing working directory.
      provisionHarness:
        generation === undefined
          ? undefined
          : (signal) =>
              this.connections
                .ensureHarnessProvisioned(generation.harnessCommit, signal)
                .pipe(
                  timedTurnProvision(context.trace, "harness", (ready) =>
                    ready ? undefined : "unavailable",
                  ),
                ),
      // Provisioning runs on use as well as on connection: the workspace can be recreated between
      // two turns, and every step converges rather than remembering a previous run.
      provision: (project, signal) =>
        this.connections.ensureProvisioned(project.id, signal).pipe(
          timedTurnProvision(context.trace, "repository", (used) =>
            used.ok ? undefined : used.problem.code,
          ),
          Effect.map((used) => used.ok),
        ),
    });
  }

  /**
   * Relay one request to the generation that serves. A mount failure with no active generation is
   * not a fault: the Supervisor holds no built-in code, so there is nothing to serve until the
   * owner submits a harness commit and activates the generation the Supervisor labels. It answers
   * 503 and says so. Every other mount failure is a fault of the active generation, and answers
   * 500.
   */
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

/** Forward a request to the facet and hand back its own status, headers and bytes. */
export async function forwardToFacet(
  request: Request,
  fetcher: Pick<Fetcher, "fetch">,
): Promise<Response> {
  try {
    return await fetcher.fetch(request);
  } catch (cause) {
    // The caller sees only the generic 502 below, on purpose (ADR-0045): a broken generation and a
    // Loader or RPC transport failure must look identical from outside. An operator still needs to
    // tell them apart, so the discarded cause is logged, redacted, with the request line, which is
    // all the activation context this function receives.
    logRedactedCause(
      `supervisor.relay.forward ${request.method} ${new URL(request.url).pathname}: ${
        isTimeoutFailure(cause) ? "timeout" : "main-facet-failed-before-headers"
      }`,
      cause,
    );

    return new Response("Main facet failed before response headers", { status: 502 });
  }
}
