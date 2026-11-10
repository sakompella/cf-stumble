import * as Effect from "effect/Effect";
import { EventsEndings } from "./events-endings.js";
import { KeyedLock } from "../../keyed-lock.js";
import type { ConversationProblem } from "./conversation-result.js";
import { ProjectConversations } from "./project-conversations.js";
import type { SelectableProject } from "./project-selection.js";

type ResolveProject = (projectId: string) => Effect.Effect<SelectableProject, ConversationProblem>;

export class ProjectThreads {
  readonly #pointers: ProjectConversations;
  readonly #endings = new EventsEndings();
  readonly #queue = new KeyedLock<SelectableProject["id"]>();
  readonly #resolve: ResolveProject;

  constructor(storage: DurableObjectStorage, resolve: ResolveProject) {
    this.#pointers = new ProjectConversations(storage);
    this.#resolve = resolve;
  }

  conversationOf(projectId: string): string | undefined {
    return this.#pointers.conversationOf(projectId);
  }

  projectOf(conversationId: string): string | undefined {
    return this.#pointers.projectOf(conversationId);
  }

  relayed(projectId: string, events: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
    return this.#endings.relayed(projectId, events);
  }

  point(projectId: string, conversationId: string): void {
    this.#pointers.point(projectId, conversationId);
  }

  exclusive<A>(
    project: SelectableProject,
    use: (current: SelectableProject) => Effect.Effect<A, ConversationProblem>,
  ): Effect.Effect<A, ConversationProblem> {
    return this.#queue.withLock(project.id, this.#resolve(project.id).pipe(Effect.flatMap(use)));
  }

  pointed<A>(
    project: SelectableProject,
    create: (current: SelectableProject) => Effect.Effect<string, ConversationProblem>,
    use: (conversationId: string) => Effect.Effect<A, ConversationProblem>,
  ): Effect.Effect<A, ConversationProblem> {
    return this.exclusive(project, (current) =>
      Effect.suspend(() => {
        const existing = this.#pointers.conversationOf(current.id);

        return existing === undefined
          ? create(current).pipe(
              Effect.tap((created) =>
                Effect.sync(() => {
                  this.#pointers.point(current.id, created);
                }),
              ),
              Effect.flatMap(use),
            )
          : use(existing);
      }),
    );
  }

  replace(
    project: SelectableProject,
    retire: (previous: string) => Effect.Effect<void, ConversationProblem>,
    create: Effect.Effect<string, ConversationProblem>,
  ): Effect.Effect<string, ConversationProblem> {
    return this.exclusive(project, (current) =>
      Effect.gen({ self: this }, function* () {
        const previous = this.#pointers.conversationOf(current.id);

        if (previous !== undefined) yield* retire(previous);

        const conversationId = yield* create;

        this.#pointers.point(current.id, conversationId);
        this.#endings.end(current.id);

        return conversationId;
      }),
    );
  }

  release<Marked>(
    projectId: SelectableProject["id"],
    running: () => boolean,
    mark: () => Marked,
  ): Effect.Effect<Readonly<{ marked: Marked }> | null> {
    return this.#queue.withLock(
      projectId,
      Effect.sync(() => {
        if (running()) return null;

        this.#pointers.forget(projectId);

        return { marked: mark() };
      }),
    );
  }
}
