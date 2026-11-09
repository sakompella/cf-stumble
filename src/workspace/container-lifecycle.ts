import * as Data from "effect/Data";

type Connection = Data.TaggedEnum<{
  Unconnected: object;
  Connected: { readonly runtimeId: string | undefined };
}>;

const Connection = Data.taggedEnum<Connection>();

export class ContainerLifecycle {
  generation = 0;
  #connection: Connection = Connection.Unconnected();

  connected(runtimeId: string | undefined): void {
    const replaced = Connection.$match(this.#connection, {
      Unconnected: () => false,
      Connected: (connected) => connected.runtimeId !== runtimeId,
    });

    if (replaced) this.generation += 1;

    this.#connection = Connection.Connected({ runtimeId });
  }

  stoppedByHost(): void {
    this.#connection = Connection.Unconnected();
  }
}
