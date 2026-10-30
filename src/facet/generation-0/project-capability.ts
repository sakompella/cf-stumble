import type { ProjectRpcTargetContract } from "../../workspace/project/protocol.js";

/**
 * Workers RPC disposes a received stub when the call returns, but a turn outlives it, so the turn holds
 * a lease on a duplicate. `release` is one-shot and runs on finish, failure, or cancel; an unreleased
 * duplicate keeps the isolate alive.
 */
export interface ProjectCapabilityLease {
  readonly capability: ProjectRpcTargetContract;
  readonly released: boolean;
  release(): void;
}

type DuplicableStub = {
  dup(): ProjectRpcTargetContract & Disposable;
};

function isDuplicableStub(
  received: ProjectRpcTargetContract,
): received is DuplicableStub & ProjectRpcTargetContract {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: reads two possibly-absent members off the received value; both are checked before use.
  const stub = received as Partial<DuplicableStub> & Partial<Disposable>;

  return typeof stub.dup === "function" && typeof stub[Symbol.dispose] === "function";
}

export function leaseProjectCapability(
  received: ProjectRpcTargetContract,
): ProjectCapabilityLease | undefined {
  if (!isDuplicableStub(received)) return undefined;

  const duplicate = received.dup();
  let released = false;

  return {
    capability: duplicate,
    get released() {
      return released;
    },
    release() {
      if (released) return;
      released = true;
      duplicate[Symbol.dispose]();
    },
  };
}
