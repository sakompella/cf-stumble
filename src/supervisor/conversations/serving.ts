import * as Effect from "effect/Effect";
import { answered, fail, parseMessage, type ConversationProblem } from "./conversation-result.js";
import {
  resolveSelectableProject,
  type SelectableCatalog,
  type SelectableProject,
} from "../../selectable-projects.js";
import { selectedWorkingDirectory } from "../../workspace-layout.js";
import { logEvent, logRedactedCause } from "../../diagnostics.js";
import {
  SERVING_FACET_NAME,
  type MainFacetMountProblem,
  type MountedFacet,
} from "../artifacts/index.js";
import { HeldWorkspaces, type ObtainWorkspace } from "./held-workspaces.js";
import {
  servingHosts,
  type EntriesRequest,
  type HostTargets,
  type RunningConversation,
} from "./host-target.js";
import { ProjectConversations } from "./project-conversations.js";
import { ConversationRuns } from "./runs.js";

type ServingPorts = Readonly<{
  ctx: DurableObjectState;
  mount: (instance: number) => Effect.Effect<MountedFacet, MainFacetMountProblem>;
  catalog: () => SelectableCatalog;
  resetting: () => boolean;
  obtainWorkspace: ObtainWorkspace;
  generations: Parameters<typeof servingHosts>[1];
  generationLabel: () => number | null;
}>;

const INSTANCE_KEY = "serving-instance";

export class ServingConversations {
  readonly #ports: ServingPorts;
  readonly #projects: ProjectConversations;
  readonly #hosts = new Map<number, HostTargets>();
  readonly #workspaces: HeldWorkspaces;
  readonly #runs: ConversationRuns;
  readonly #readers = new Map<string, Set<() => void>>();

  constructor(ports: ServingPorts) {
    this.#ports = ports;
    this.#projects = new ProjectConversations(ports.ctx.storage);
    this.#workspaces = new HeldWorkspaces(ports.obtainWorkspace);
    this.#runs = new ConversationRuns(ports.ctx.storage);
  }

  serves(instance: number): boolean {
    return instance === this.#instance();
  }

  admitModelTurn(instance: number): boolean {
    const admitted = this.serves(instance);

    if (!admitted) this.#workspaces.flushRetirement();

    return admitted;
  }

  started(version: string | null): void {
    logEvent("info", "do.started", { class: "Supervisor", version });
  }

  replaceFacet(
    command: Readonly<{ kind: "activate" | "rollback"; label: number }>,
    epoch: number,
  ): void {
    logEvent(
      "info",
      command.kind === "activate" ? "generation.activated" : "generation.rolled-back",
      {
        label: command.label,
        epoch,
      },
    );
    this.#ports.ctx.storage.kv.put(INSTANCE_KEY, this.#instance() + 1);
    this.#hosts.clear();
    this.#workspaces.retire(() => {
      this.#ports.ctx.facets.abort(SERVING_FACET_NAME, "another generation serves");
    });
  }

  running(): boolean {
    return this.#runs.running(Date.now());
  }

  submit(projectId: string, content: string, requestId: string) {
    return answered(
      Effect.gen({ self: this }, function* () {
        const message = parseMessage(content, requestId);
        const project = yield* this.#project(projectId);

        if (message === undefined) return yield* fail("invalid-message");

        if (this.#ports.resetting()) return yield* fail("workspace-busy");

        const facet = yield* this.#facet();
        const conversationId = yield* this.#conversation(facet, project);

        const submissionId = yield* this.#call(() =>
          facet.submit(conversationId, message.content, message.requestId),
        );

        return { submissionId };
      }),
    );
  }

  events(projectId: string, from?: number) {
    return answered(
      Effect.gen({ self: this }, function* () {
        const project = yield* this.#project(projectId);
        const facet = yield* this.#facet();
        const conversationId = yield* this.#conversation(facet, project);
        const events = yield* this.#call(() => facet.events(conversationId, from));

        return { events: this.#endedWhenReplaced(conversationId, events) };
      }),
    );
  }

  entries(projectId: string, request: EntriesRequest) {
    return answered(
      Effect.gen({ self: this }, function* () {
        const project = yield* this.#project(projectId);
        const facet = yield* this.#facet();
        const conversationId = yield* this.#conversation(facet, project);
        const page = yield* this.#call(() => facet.entries(conversationId, request));

        return { page };
      }),
    );
  }

  abort(projectId: string) {
    return answered(
      Effect.gen({ self: this }, function* () {
        const project = yield* this.#project(projectId);
        const conversationId = this.#projects.conversationOf(project.id);

        if (conversationId === undefined) return {};
        const facet = yield* this.#facet();
        yield* this.#call(() => facet.abort(conversationId));

        return {};
      }),
    );
  }

  freshThread(projectId: string) {
    return answered(
      Effect.gen({ self: this }, function* () {
        const project = yield* this.#project(projectId);
        const facet = yield* this.#facet();
        const previous = this.#projects.conversationOf(project.id);

        if (previous !== undefined) yield* this.#call(() => facet.abort(previous));

        const conversationId = yield* this.#call(() =>
          facet.createConversation(selectedWorkingDirectory(project)),
        );

        this.#projects.point(project.id, conversationId);

        for (const end of previous === undefined ? [] : (this.#readers.get(previous) ?? [])) end();

        return { conversationId };
      }),
    );
  }

  release(projectId: string): boolean {
    if (this.running()) return false;

    this.#projects.forget(projectId);

    return true;
  }

  alarm(now: number): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      for (const conversationId of this.#runs.expired(now)) this.#workspaces.end(conversationId);

      const facet = yield* this.#facet();

      for (const conversationId of this.#runs.expired(now)) {
        logEvent("warn", "run.deadline-aborted", { generation: this.#ports.generationLabel() });
        yield* this.#call(() => facet.abort(conversationId));
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

  #instance(): number {
    return this.#ports.ctx.storage.kv.get<number>(INSTANCE_KEY) ?? 0;
  }

  #project(projectId: string): Effect.Effect<SelectableProject, ConversationProblem> {
    const resolved = resolveSelectableProject(projectId, this.#ports.catalog());

    return resolved.ok ? Effect.succeed(resolved.project) : fail(resolved.reason);
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

  #conversation(
    facet: MountedFacet,
    project: SelectableProject,
  ): Effect.Effect<string, ConversationProblem> {
    const existing = this.#projects.conversationOf(project.id);

    if (existing !== undefined) return Effect.succeed(existing);

    return this.#call(() => facet.createConversation(selectedWorkingDirectory(project))).pipe(
      Effect.map((created) => {
        const raced = this.#projects.conversationOf(project.id);

        if (raced !== undefined) return raced;
        this.#projects.point(project.id, created);

        return created;
      }),
    );
  }

  #facet(): Effect.Effect<MountedFacet, ConversationProblem> {
    return Effect.suspend(() => {
      this.#workspaces.flushRetirement();

      return this.#ports.mount(this.#instance());
    }).pipe(
      Effect.mapError((problem): ConversationProblem => ({
        code: problem.code === "no-active-generation" ? "no-active-generation" : "mount-failed",
      })),
      Effect.tap((facet) => this.#call(() => this.#attach(facet))),
    );
  }

  #attach(facet: MountedFacet): Promise<void> {
    const instance = this.#instance();
    const existing = this.#hosts.get(instance);

    if (existing !== undefined) return facet.attach(existing.host, existing.generations);

    const targets = servingHosts(
      {
        arm: (wake) => this.#runs.arm(wake, Date.now()),
        log: (level, event, fields) => {
          logEvent(level, `facet.${event.slice(0, 60)}`, {
            ...fields,
            generation: this.#ports.generationLabel(),
          });
        },
        running: (conversations) => this.#running(conversations),
        workspace: (conversationId) => this.#workspace(conversationId),
      },
      this.#ports.generations,
      () => this.serves(instance),
    );

    this.#hosts.set(instance, targets);

    return facet.attach(targets.host, targets.generations);
  }

  #endedWhenReplaced(
    conversationId: string,
    events: ReadableStream<Uint8Array>,
  ): ReadableStream<Uint8Array> {
    const source = events.getReader();
    const readers = this.#readers.get(conversationId) ?? new Set();
    let opened: ReadableStreamDefaultController<Uint8Array> | undefined;
    let ended = false;
    let reading = false;

    const forget = () => {
      readers.delete(end);

      if (readers.size === 0) this.#readers.delete(conversationId);
    };

    const stop = () => {
      ended = true;
      forget();

      if (!reading) void source.cancel().catch(() => {});
    };

    const end = () => {
      stop();
      opened?.close();
    };

    const readable = new ReadableStream<Uint8Array>({
      start: (controller) => {
        opened = controller;
      },
      pull: async (controller) => {
        reading = true;
        const next = await source.read().catch(() => ({ done: true }) as const);
        reading = false;

        if (ended) {
          void source.cancel().catch(() => {});
        } else if (next.done) {
          forget();
          controller.close();
        } else {
          controller.enqueue(next.value);
        }
      },
      cancel: stop,
    });

    readers.add(end);
    this.#readers.set(conversationId, readers);

    return readable;
  }

  async #running(conversations: readonly RunningConversation[]): Promise<void> {
    const now = Date.now();

    for (const conversationId of this.#runs.reconcile(
      conversations,
      now,
      this.#ports.generationLabel(),
    )) {
      this.#workspaces.end(conversationId);
    }

    await this.#runs.setAlarm(now);
  }

  #workspace(conversationId: string) {
    const projectId = this.#projects.projectOf(conversationId);
    const project = this.#ports.catalog().find((candidate) => candidate.id === projectId);
    const remainingMs = this.#runs.remainingMs(conversationId, Date.now());

    if (project === undefined || remainingMs === undefined || this.#ports.resetting()) {
      return Promise.reject(new Error("this conversation has no running project workspace"));
    }

    return this.#workspaces.capability(conversationId, project, remainingMs);
  }
}
