// oxlint-disable import/max-dependencies -- The serving side is where the facet, the project catalog, the workspace and the run deadline meet.
import * as Effect from "effect/Effect";
import { answered, fail, parseMessage, type ConversationProblem } from "./conversation-result.js";
import * as Result from "effect/Result";
import type { Wake } from "@earendil-works/pi-durable";
import type { ProjectRpcTargetContract } from "../../workspace/project/protocol.js";
import {
  resolveSelectableProject,
  type SelectableCatalog,
  type SelectableProject,
} from "../../selectable-projects.js";
import { selectedWorkingDirectory } from "../../workspace-layout.js";
import { logRedactedCause } from "../../diagnostics.js";
import { PROJECT_RUN_DEADLINE_MS } from "../../turn-budget.js";
import {
  SERVING_FACET_NAME,
  type MainFacetMountProblem,
  type MountedFacet,
} from "../artifacts/index.js";
import { HeldWorkspaces, type ObtainWorkspace } from "./held-workspaces.js";
import { ConversationHostTarget } from "./host-target.js";
import { ProjectConversations } from "./project-conversations.js";
import { alarmAt } from "./wake.js";

const RUN_DEADLINE_KEY = "conversations.run-deadline";

type ServingPorts = Readonly<{
  ctx: DurableObjectState;
  mount: () => Result.Result<MountedFacet, MainFacetMountProblem>;
  catalog: () => SelectableCatalog;
  resetting: () => boolean;
  /** Provisions the project's checkout and obtains a capability that ends after `remainingMs`. */
  obtainWorkspace: ObtainWorkspace;
}>;

/**
 * The Supervisor's side of the agent loop (ADR-0048). Pi Durable's session lives in the serving
 * facet's own storage, under one name for every generation, so one instance writes it. Facets
 * cannot set alarms, so the facet relays its wake to `arm`, and the Supervisor's alarm attaches
 * the facet again, which resumes whatever work a lost instance left.
 */
export class ServingConversations {
  readonly #ports: ServingPorts;
  readonly #projects: ProjectConversations;
  readonly #host: ConversationHostTarget;
  readonly #workspaces: HeldWorkspaces;

  constructor(ports: ServingPorts) {
    this.#ports = ports;
    this.#projects = new ProjectConversations(ports.ctx.storage);
    this.#workspaces = new HeldWorkspaces(ports.obtainWorkspace);
    this.#host = new ConversationHostTarget({
      arm: (wake) => this.#arm(wake),
      workspace: (conversationId) => this.#workspace(conversationId),
    });
  }

  /** The next call mounts the newly active generation's class; its work resumes from storage. */
  replaceFacet(): void {
    this.#ports.ctx.facets.abort(SERVING_FACET_NAME, "another generation serves");
    this.endWorkspaces();
  }

  /** A run is active from the wake that started it until the wake that settled it. */
  running(): boolean {
    return this.#runDeadline() !== undefined;
  }

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Boundary: every argument arrives from a client.
  submit(projectId: unknown, content: unknown, requestId: unknown) {
    return answered(
      Effect.gen({ self: this }, function* () {
        const message = parseMessage(content, requestId);
        const project = yield* this.#project(projectId);

        if (message === undefined) return yield* fail("invalid-message");

        const facet = yield* this.#facet();
        const conversationId = yield* this.#conversation(facet, project);

        const submissionId = yield* this.#call(() =>
          facet.submit(conversationId, message.content, message.requestId),
        );

        return { submissionId };
      }),
    );
  }

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Boundary: the project id arrives from a client.
  events(projectId: unknown) {
    return answered(
      Effect.gen({ self: this }, function* () {
        const project = yield* this.#project(projectId);
        const facet = yield* this.#facet();
        const conversationId = yield* this.#conversation(facet, project);
        const events = yield* this.#call(() => facet.events(conversationId));

        return { events };
      }),
    );
  }

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Boundary: the project id arrives from a client.
  abort(projectId: unknown) {
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

  /** The old conversation stays in storage; only the project's row moves. */
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Boundary: the project id arrives from a client.
  freshThread(projectId: unknown) {
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

        return { conversationId };
      }),
    );
  }

  /** A disconnected project's conversation is left unreferenced, like a fresh thread's predecessor. */
  forget(projectId: string): void {
    this.#projects.forget(projectId);
  }

  /** Attaching resumes the session; past the run's deadline every current conversation is aborted. */
  alarm(now: number): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      const facet = yield* this.#facet();
      const deadline = this.#runDeadline();

      if (deadline === undefined || now < deadline) return;

      for (const conversationId of this.#projects.conversations()) {
        yield* this.#call(() => facet.abort(conversationId));
      }

      this.#ports.ctx.storage.kv.delete(RUN_DEADLINE_KEY);
      this.endWorkspaces();
    }).pipe(
      Effect.catch((problem) =>
        Effect.sync(() => {
          logRedactedCause("supervisor.conversations.alarm", problem);
        }),
      ),
    );
  }

  /** Ends every capability handed out, which kills the commands still running through them. */
  endWorkspaces(): void {
    this.#workspaces.endAll();
  }

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Boundary: the project id arrives from a client.
  #project(projectId: unknown): Effect.Effect<SelectableProject, ConversationProblem> {
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

  /** Attaching on every call costs one local RPC and covers a facet instance that was lost. */
  #facet(): Effect.Effect<MountedFacet, ConversationProblem> {
    return Effect.gen({ self: this }, function* () {
      const mounted = this.#ports.mount();

      if (Result.isFailure(mounted)) {
        return yield* fail(
          mounted.failure.code === "no-active-generation" ? "no-active-generation" : "mount-failed",
        );
      }

      const facet = mounted.success;
      yield* this.#call(() => facet.attach(this.#host));

      return facet;
    });
  }

  #runDeadline(): number | undefined {
    return this.#ports.ctx.storage.kv.get<number>(RUN_DEADLINE_KEY);
  }

  async #arm(wake: Wake): Promise<void> {
    const now = Date.now();
    const { storage } = this.#ports.ctx;
    let deadline = this.#runDeadline();

    if (wake.active && deadline === undefined) {
      deadline = now + PROJECT_RUN_DEADLINE_MS;
      storage.kv.put(RUN_DEADLINE_KEY, deadline);
    }

    if (!wake.active && deadline !== undefined) {
      deadline = undefined;
      storage.kv.delete(RUN_DEADLINE_KEY);
      this.endWorkspaces();
    }

    const at = alarmAt(wake, now, deadline);

    await (at === undefined ? storage.deleteAlarm() : storage.setAlarm(at));
  }

  #workspace(conversationId: string): Promise<ProjectRpcTargetContract> {
    const projectId = this.#projects.projectOf(conversationId);
    const project = this.#ports.catalog().find((candidate) => candidate.id === projectId);

    if (project === undefined || this.#ports.resetting()) {
      return Promise.reject(new Error("this conversation has no project workspace"));
    }

    const now = Date.now();
    const deadline = this.#runDeadline() ?? now + PROJECT_RUN_DEADLINE_MS;

    return this.#workspaces.capability(project, Math.max(0, deadline - now));
  }
}
