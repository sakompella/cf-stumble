import { DurableObject } from "cloudflare:workers";
import * as Effect from "effect/Effect";
import type { HarnessCommit } from "../harness-commit.js";
import type {
  ActivationCommand,
  GenerationActor,
  GenerationControlResult,
  GenerationLabel,
} from "./generation-state.js";
import { WORKSPACE_BUSY, type WorkspaceHostNamespace } from "../workspace/index.js";
import type { EntriesRequest } from "../entries-request.js";
import { runAtEntryPoint } from "../run-entry-point.js";
import { checkGenerationStartup, type StartupCheckResult } from "./startup-check/index.js";
import { supervisorParts, type SupervisorParts } from "./supervisor-parts.js";
import type {
  BackendSetting,
  SupervisorEnv,
  SupervisorWorkspaceReset,
  WorkspaceBackendChange,
} from "./supervisor-env.js";

const WORKSPACE_UNAVAILABLE = { ok: false, problem: { code: "workspace-unavailable" } } as const;

const RUN_ACTIVE = { ok: false, problem: { code: "run-active" } } as const;

export class Supervisor extends DurableObject<SupervisorEnv> {
  readonly #parts: SupervisorParts;
  readonly #preparations = new Map<GenerationLabel, Promise<StartupCheckResult>>();
  #resetInProgress = false;

  constructor(ctx: DurableObjectState, env: SupervisorEnv) {
    super(ctx, env);
    this.#parts = supervisorParts(ctx, env, () => this.#resetInProgress, {
      getActiveGeneration: () => this.getActiveGeneration(),
      submitGeneration: (harnessCommit) =>
        this.#parts.generations.submit(harnessCommit, "conversation"),
      prepareGeneration: (label) => this.#prepare(label, "conversation"),
      controlGeneration: (command) =>
        runAtEntryPoint(this.#activate(command, "conversation", true, () => false)),
    });
    this.#parts.serving.started(env.CF_VERSION_METADATA?.id ?? null);
  }

  prepareGeneration(label: GenerationLabel) {
    return this.#prepare(label, "owner");
  }

  #prepare(label: GenerationLabel, actor: GenerationActor) {
    const pending = this.#preparations.get(label);

    if (pending !== undefined) return pending;

    const checking = runAtEntryPoint(
      Effect.gen({ self: this }, function* () {
        const result = yield* checkGenerationStartup(this.#parts.startupCheckHost, label, actor);

        yield* this.#recordMainAhead(label);

        return result;
      }),
    ).finally(() => {
      this.#preparations.delete(label);
    });

    this.#preparations.set(label, checking);

    return checking;
  }

  #recordMainAhead(label: GenerationLabel): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      const { generations, lineage } = this.#parts;
      const active = generations.active().generation?.harnessCommit;
      const target = generations.byLabel(label)?.harnessCommit;

      if (active === undefined || target === undefined) return;

      lineage.record(active, (yield* lineage.read(active, target)).mainAheadOfActive);
    });
  }

  getActiveGeneration() {
    return this.#parts.generations.active();
  }

  submitGeneration(harnessCommit: HarnessCommit) {
    return this.#parts.generations.submit(harnessCommit, "owner");
  }

  scriptVersion(): string | null {
    return this.env.CF_VERSION_METADATA?.id ?? null;
  }

  getStatus() {
    return this.#parts.lineage.status(this.#parts.generations.active());
  }

  controlGeneration(command: ActivationCommand, force = false): Promise<GenerationControlResult> {
    const running = () => this.#parts.serving.running();

    if (running()) return Promise.resolve(RUN_ACTIVE);

    return runAtEntryPoint(this.#activate(command, "owner", force, running));
  }

  #activate(
    command: ActivationCommand,
    actor: GenerationActor,
    force: boolean,
    running: () => boolean,
  ): Effect.Effect<GenerationControlResult> {
    return Effect.gen({ self: this }, function* () {
      const { generations, lineage } = this.#parts;
      const active = generations.active().generation?.harnessCommit;
      const target = generations.byLabel(command.label)?.harnessCommit;

      if (command.kind === "rollback" || active === undefined || target === undefined) {
        return this.#switch(command, actor, running);
      }

      const known = active === target ? undefined : yield* lineage.read(active, target);

      if (known !== undefined) lineage.record(active, known.mainAheadOfActive);

      const dropped = known?.containsActive === false ? active : undefined;

      if (dropped !== undefined && !force) {
        return running() ? RUN_ACTIVE : { ok: false, problem: { code: "drops-active-commit" } };
      }

      const result = this.#switch(command, actor, running);

      if (known !== undefined && result.ok && result.outcome.effect === "activated") {
        lineage.record(target, known.mainAheadOfTarget);
      }

      return result.ok && dropped !== undefined
        ? { ok: true, outcome: { ...result.outcome, droppedCommit: dropped } }
        : result;
    });
  }

  #switch(
    command: ActivationCommand,
    actor: GenerationActor,
    running: () => boolean,
  ): GenerationControlResult {
    if (running()) return RUN_ACTIVE;

    const result = this.#parts.generations.activate(command, actor);

    if (result.ok && result.outcome.effect === "activated") {
      this.#parts.serving.replaceFacet(command, result.outcome.epoch);
    }

    return result;
  }

  listProjects() {
    return this.#parts.connections.catalog();
  }

  getGitHubConnection() {
    return this.#parts.github.lastKnown(Date.now());
  }

  refreshGitHubConnection() {
    return runAtEntryPoint(this.#parts.github.refresh(Date.now()));
  }

  resetWorkspace(): Promise<SupervisorWorkspaceReset> {
    if (this.#resetInProgress) return Promise.resolve(WORKSPACE_BUSY);

    this.#resetInProgress = true;

    return runAtEntryPoint(
      Effect.gen({ self: this }, function* () {
        if (this.#parts.serving.running()) {
          return { ok: false, problem: { code: "run-active" } } as const;
        }

        const namespace: WorkspaceHostNamespace<"reset"> = this.env.WORKSPACE_HOST;

        const result = yield* Effect.tryPromise({
          try: () => namespace.getByName(this.#parts.workspaceName).reset(),
          catch: () => WORKSPACE_UNAVAILABLE,
        }).pipe(Effect.catch(Effect.succeed));

        if (result.ok) {
          this.#parts.readiness.forget();
          this.#parts.serving.endWorkspaces();
        }

        return result;
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            this.#resetInProgress = false;
          }),
        ),
      ),
    );
  }

  getWorkspaceBackend(): Promise<BackendSetting> {
    return this.env.WORKSPACE_HOST.getByName(this.#parts.workspaceName).backend();
  }

  setWorkspaceBackend(setting: BackendSetting): Promise<WorkspaceBackendChange> {
    if (this.#resetInProgress) return Promise.resolve(WORKSPACE_BUSY);

    return this.env.WORKSPACE_HOST.getByName(this.#parts.workspaceName).setBackend(setting);
  }

  connectProject(repositoryUrl: string) {
    if (this.#resetInProgress) {
      return Promise.resolve({
        ok: false,
        problem: { code: "workspace-busy", detail: "" },
      } as const);
    }

    return runAtEntryPoint(this.#parts.connections.connect(repositoryUrl, Date.now()));
  }

  disconnectProject(projectId: string) {
    if (this.#resetInProgress) return Promise.resolve(WORKSPACE_BUSY);

    const { connections, serving } = this.#parts;

    return runAtEntryPoint(
      connections.disconnect(projectId, (connected, mark) => serving.release(connected, mark)),
    );
  }

  startGitHubAuthorization() {
    return runAtEntryPoint(this.#parts.github.startAuthorization(Date.now()));
  }

  completeGitHubAuthorization() {
    return runAtEntryPoint(this.#parts.github.completeAuthorization(Date.now()));
  }

  getChatGPTConnection() {
    return this.#parts.chatgpt.view();
  }

  startChatGPTLogin() {
    return runAtEntryPoint(this.#parts.chatgpt.startLogin());
  }

  completeChatGPTLogin(attemptId: string, callbackUrl: string) {
    return runAtEntryPoint(this.#parts.chatgpt.completeLogin(attemptId, callbackUrl));
  }

  disconnectChatGPT() {
    return this.#parts.chatgpt.disconnect();
  }

  admitModelTurn(instance: number): boolean {
    return this.#parts.serving.admitModelTurn(instance);
  }

  chatgptAccess(rejected?: string) {
    return runAtEntryPoint(this.#parts.chatgpt.access(rejected));
  }

  markChatGPTRefused(accessToken: string): void {
    this.#parts.chatgpt.markRefused(accessToken);
  }

  markChatGPTUsageLimited(accessToken: string, limitedUntil: number | null): void {
    this.#parts.chatgpt.markUsageLimited(
      accessToken,
      limitedUntil !== null && Number.isFinite(limitedUntil) ? limitedUntil : null,
    );
  }

  submitProjectMessage(
    projectId: string,
    content: string,
    requestId: string,
    budgetMinutes: number,
  ) {
    return runAtEntryPoint(
      this.#parts.serving.submit(projectId, content, requestId, budgetMinutes),
    );
  }

  projectEvents(projectId: string, from?: number) {
    return runAtEntryPoint(this.#parts.serving.events(projectId, from));
  }

  projectEntries(projectId: string, request: EntriesRequest) {
    return runAtEntryPoint(this.#parts.serving.entries(projectId, request));
  }

  abortProjectRun(projectId: string) {
    return runAtEntryPoint(this.#parts.serving.abort(projectId));
  }

  freshProjectConversation(projectId: string) {
    return runAtEntryPoint(this.#parts.serving.freshThread(projectId));
  }

  override alarm(): Promise<void> {
    return runAtEntryPoint(this.#parts.serving.alarm(Date.now()));
  }
}
