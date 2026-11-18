import * as Effect from "effect/Effect";
import { answered, fail, parseMessage, type ConversationProblem } from "./conversation-result.js";
import { logEvent, logRedactedCause } from "../../diagnostics.js";
import {
  SERVING_FACET_NAME,
  type MainFacetModel,
  type MainFacetMountProblem,
  type MainHarnessArtifact,
  type MountedFacet,
} from "../artifacts/index.js";
import { runAtEntryPoint } from "../../run-entry-point.js";
import { HeldWorkspaces, type ObtainWorkspace } from "./held-workspaces.js";
import { servingHosts, type EntriesRequest, type HostTargets } from "./host-target.js";
import { ProjectThreads } from "./project-threads.js";
import {
  createConversation,
  resolveProject,
  type SelectableCatalog,
  type SelectableProject,
} from "./project-selection.js";
import { ConversationRuns, DeadlineAborts, type Settlement } from "./runs.js";

type ServingPorts = Readonly<{
  ctx: DurableObjectState;
  load: () => Effect.Effect<MainHarnessArtifact, MainFacetMountProblem>;
  start: (artifact: MainHarnessArtifact) => MountedFacet;
  model: (instance: number) => MainFacetModel;
  catalog: () => SelectableCatalog;
  resetting: () => boolean;
  obtainWorkspace: ObtainWorkspace;
  generations: Parameters<typeof servingHosts>[1];
  selection: Readonly<{
    active: () => Readonly<{ generation: Readonly<{ label: number }> | undefined }>;
    settled: (settlement: Settlement) => void;
    servingInstance: () => number;
  }>;
}>;

type MountedOnInstance = Readonly<{ facet: MountedFacet; instance: number }>;

type InstanceHosts = HostTargets & Readonly<{ instance: number; model: MainFacetModel }>;

export class ServingConversations {
  readonly #ports: ServingPorts;
  readonly #projects: ProjectThreads;
  #hosts: InstanceHosts | undefined;
  readonly #workspaces: HeldWorkspaces;
  readonly #runs: ConversationRuns;
  readonly #deadlines = new DeadlineAborts();

  constructor(ports: ServingPorts) {
    this.#ports = ports;
    this.#projects = new ProjectThreads(ports.ctx.storage, (id) =>
      resolveProject(id, ports.catalog()),
    );
    this.#workspaces = new HeldWorkspaces(ports.obtainWorkspace);
    this.#runs = new ConversationRuns(ports.ctx.storage);
  }

  serves(instance: number): boolean {
    return instance === this.#instance();
  }

  admitModelTurn(instance: number): boolean {
    const admitted = this.serves(instance);

    if (admitted) this.#runs.modelTurn(instance, Date.now());
    else this.#workspaces.flushRetirement();

    return admitted;
  }

  started(version: string | null): void {
    logEvent("info", "do.started", { class: "Supervisor", version });
  }

  replaceFacet(): void {
    this.#workspaces.retire(() => {
      this.#ports.ctx.facets.abort(SERVING_FACET_NAME, "another generation serves");
    });
  }

  running(): boolean {
    return this.#runs.running(Date.now());
  }

  submit(
    projectId: string,
    content: string,
    requestId: string,
    budgetMinutes: number,
    writtenFor?: string,
  ) {
    return answered(
      Effect.gen({ self: this }, function* () {
        const message = parseMessage(content, requestId);
        const project = yield* this.#project(projectId);

        if (message === undefined) return yield* fail("invalid-message");

        if (this.#ports.resetting()) return yield* fail("workspace-busy");

        const mounted = yield* this.#mounted();

        return yield* this.#projects.pointed(
          project,
          (current) => this.#use(mounted, (facet) => createConversation(facet, current)),
          (conversationId) =>
            writtenFor === undefined || writtenFor === conversationId
              ? Effect.suspend(() => {
                  this.#runs.submitted(conversationId);

                  return this.#use(mounted, (facet) =>
                    facet.submit(conversationId, message.content, message.requestId, budgetMinutes),
                  );
                }).pipe(Effect.map((submissionId) => ({ submissionId })))
              : fail("thread-replaced"),
        );
      }),
    );
  }

  events(projectId: string, from?: number) {
    return answered(
      Effect.gen({ self: this }, function* () {
        const project = yield* this.#project(projectId);
        const mounted = yield* this.#mounted();

        return yield* this.#projects.pointed(
          project,
          (current) => this.#use(mounted, (facet) => createConversation(facet, current)),
          (conversationId) =>
            this.#use(mounted, (facet) => facet.events(conversationId, from)).pipe(
              Effect.map((events) => ({ events: this.#projects.relayed(project.id, events) })),
            ),
        );
      }),
    );
  }

  entries(projectId: string, request: EntriesRequest) {
    return answered(
      Effect.gen({ self: this }, function* () {
        const project = yield* this.#project(projectId);
        const mounted = yield* this.#mounted();

        return yield* this.#projects.pointed(
          project,
          (current) => this.#use(mounted, (facet) => createConversation(facet, current)),
          (conversationId) =>
            this.#use(mounted, (facet) => facet.entries(conversationId, request)).pipe(
              Effect.map((page) => ({ page })),
            ),
        );
      }),
    );
  }

  abort(projectId: string) {
    return answered(
      Effect.gen({ self: this }, function* () {
        const project = yield* this.#project(projectId);
        const conversationId = this.#projects.conversationOf(project.id);

        if (conversationId === undefined) return {};
        const mounted = yield* this.#mounted();
        yield* this.#use(mounted, (facet) => facet.abort(this.#runs.cancelled(conversationId)));

        return {};
      }),
    );
  }

  freshThread(projectId: string) {
    return answered(
      Effect.gen({ self: this }, function* () {
        const project = yield* this.#project(projectId);
        const mounted = yield* this.#mounted();

        const conversationId = yield* this.#projects.replace(
          project,
          (old) => this.#use(mounted, (facet) => facet.abort(this.#runs.cancelled(old))),
          this.#use(mounted, (facet) => createConversation(facet, project)),
        );

        return { conversationId };
      }),
    );
  }

  release<Marked>(projectId: SelectableProject["id"], mark: () => Marked) {
    const isRunning = (conversationId: string) => this.#runs.isRunning(conversationId, Date.now());

    return this.#projects.release(projectId, isRunning, mark);
  }

  alarm(now: number): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      const expired = () => this.#deadlines.waiting(this.#runs.expired(now));

      for (const conversationId of expired()) this.#workspaces.end(conversationId);

      const { facet, instance } = yield* this.#mountNow();

      for (const conversationId of expired()) {
        logEvent("warn", "run.deadline-aborted", { generation: this.#generationLabel() });
        this.#deadlines.end(
          conversationId,
          () => facet.abort(this.#runs.interrupted(conversationId), "deadline"),
          (run) =>
            this.#settled(this.#runs.continued(run, Date.now(), instance, this.#generationLabel())),
        );
      }
    }).pipe(
      Effect.tapError((problem) =>
        Effect.sync(() => {
          logRedactedCause("supervisor.conversations.alarm", problem);
        }),
      ),
      Effect.orDie,
    );
  }

  endWorkspaces(): void {
    this.#workspaces.endAll();
  }

  #generationLabel(): number | null {
    return this.#ports.selection.active().generation?.label ?? null;
  }

  #instance(): number {
    return this.#ports.selection.servingInstance();
  }

  #project(projectId: string): Effect.Effect<SelectableProject, ConversationProblem> {
    return resolveProject(projectId, this.#ports.catalog());
  }

  #call<T>(call: () => Promise<T>): Effect.Effect<T, ConversationProblem> {
    return Effect.tryPromise({
      try: call,
      catch: (cause) => {
        logRedactedCause("supervisor.conversations.facet-call", cause);

        return { code: "generation-failed" } as const;
      },
    });
  }

  #mounted(): Effect.Effect<MountedOnInstance, ConversationProblem> {
    return Effect.suspend(() => {
      const instance = this.#instance();

      return this.#mountNow().pipe(
        Effect.catch((problem) =>
          this.serves(instance) ? Effect.fail(problem) : this.#mountNow(),
        ),
      );
    });
  }

  #mountNow(): Effect.Effect<MountedOnInstance, ConversationProblem> {
    return this.#started().pipe(Effect.tap((mounted) => this.#call(() => this.#attach(mounted))));
  }

  #started(): Effect.Effect<MountedOnInstance, ConversationProblem> {
    return Effect.suspend(() => {
      const instance = this.#instance();

      return this.#ports.load().pipe(
        Effect.mapError((problem): ConversationProblem => ({
          code: problem.code === "no-active-generation" ? "no-active-generation" : "mount-failed",
        })),
        Effect.flatMap((artifact) =>
          this.serves(instance) ? Effect.succeed(this.#start(artifact, instance)) : this.#started(),
        ),
      );
    });
  }

  #start(artifact: MainHarnessArtifact, instance: number): MountedOnInstance {
    this.#workspaces.flushRetirement();

    return { facet: this.#ports.start(artifact), instance };
  }

  #use<T>(
    mounted: MountedOnInstance,
    call: (facet: MountedFacet) => Promise<T>,
  ): Effect.Effect<T, ConversationProblem> {
    return this.#call(() => call(mounted.facet)).pipe(
      Effect.catch((problem) =>
        this.serves(mounted.instance)
          ? Effect.fail(problem)
          : this.#mountNow().pipe(Effect.flatMap((next) => this.#call(() => call(next.facet)))),
      ),
    );
  }

  #attach({ facet, instance }: MountedOnInstance): Promise<void> {
    const existing = this.#hosts?.instance === instance ? this.#hosts : undefined;

    if (existing !== undefined) {
      return facet.attach(existing.host, existing.model, existing.generations);
    }

    const targets = servingHosts(
      {
        arm: (wake) => runAtEntryPoint(this.#runs.arm(wake, Date.now())),
        log: (level, event, fields) => {
          logEvent(level, `facet.${event.slice(0, 60)}`, {
            ...fields,
            generation: this.#generationLabel(),
          });
        },
        running: (report) =>
          this.#settle(this.#runs.reconcile(report, Date.now(), instance, this.#generationLabel())),
        workspace: (conversationId) => this.#workspace(conversationId),
      },
      this.#ports.generations,
      () => this.serves(instance),
    );

    const model = this.#ports.model(instance);

    this.#hosts = { ...targets, instance, model };

    return facet.attach(targets.host, model, targets.generations);
  }

  #settle(settlements: readonly Settlement[]): Promise<void> {
    for (const settlement of settlements) this.#workspaces.end(settlement.conversationId);

    return this.#settled(settlements);
  }

  async #settled(settlements: readonly Settlement[]): Promise<void> {
    for (const settlement of settlements) this.#ports.selection.settled(settlement);

    await runAtEntryPoint(this.#runs.setAlarm(Date.now()));
  }

  #workspace(conversationId: string) {
    const projectId = this.#projects.projectOf(conversationId);
    const project = this.#ports.catalog().find((candidate) => candidate.id === projectId);

    const remainingMs = this.#deadlines.remainingMs(
      conversationId,
      this.#runs.remainingMs(conversationId, Date.now()),
    );

    if (project === undefined || remainingMs === undefined || this.#ports.resetting()) {
      return Promise.reject(new Error("this conversation has no running project workspace"));
    }

    return this.#workspaces.capability(conversationId, project, remainingMs);
  }
}
