import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

export class EventsEndings {
  readonly #pending = new Map<string, Deferred.Deferred<void>>();

  relayed(projectId: string, events: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
    const existing = this.#pending.get(projectId);
    const ending = existing ?? Deferred.makeUnsafe<void>();
    this.#pending.set(projectId, ending);

    return Stream.toReadableStream(
      Stream.fromReadableStream({ evaluate: () => events, onError: (cause) => cause }).pipe(
        Stream.interruptWhen(Deferred.await(ending)),
        Stream.catch(() => Stream.empty),
      ),
    );
  }

  end(projectId: string): void {
    const ending = this.#pending.get(projectId);

    if (ending === undefined) return;
    this.#pending.delete(projectId);
    Deferred.doneUnsafe(ending, Effect.void);
  }
}
