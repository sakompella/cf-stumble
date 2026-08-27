import { TaggedError } from "better-result";

/** The storage operations whose infrastructure failures can be surfaced to callers. */
export type StorageOperation =
  | "readObject"
  | "writeObject"
  | "readPointer"
  | "setPointer"
  | "listObjects"
  | "deleteObject";

/** Durable Object storage could not complete an operation, but its contents remain recoverable. */
export class StorageUnavailableError extends TaggedError("StorageUnavailableError")<{
  operation: StorageOperation;
  cause: unknown;
  message: string;
}> {
  constructor(args: { operation: StorageOperation; cause: unknown }) {
    super({
      ...args,
      message: `storage temporarily unavailable while ${args.operation}`,
    });
  }
}

/** Durable Object SQLite reported that its durable storage has no remaining capacity. */
export class StorageCapacityError extends TaggedError("StorageCapacityError")<{
  operation: StorageOperation;
  cause: unknown;
  message: string;
}> {
  constructor(args: { operation: StorageOperation; cause: unknown }) {
    super({
      ...args,
      message: `storage capacity exceeded while ${args.operation}`,
    });
  }
}
