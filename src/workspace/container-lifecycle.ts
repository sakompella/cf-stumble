import * as Data from "effect/Data";
import { WORKSPACE_IDLE_STOP_MS } from "./idle-stop.js";

export const CONTAINER_INACTIVITY_TIMEOUT_MS = WORKSPACE_IDLE_STOP_MS + 60_000;

type Connection = Data.TaggedEnum<{
  Unconnected: object;
  Connected: { readonly runtimeId: string | undefined };
}>;

const Connection = Data.taggedEnum<Connection>();

export class ContainerStopFailed extends Data.TaggedError("ContainerStopFailed")<{
  readonly cause: unknown;
}> {}

export class ContainerLifecycle {
  generation = 0;
  #connection: Connection = Connection.Unconnected();

  isConnected(): boolean {
    return Connection.$is("Connected")(this.#connection);
  }

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
