import type { ProjectRpcTargetContract } from "../../workspace/project/protocol.js";

/**
 * A project capability whose lifetime this facet controls.
 *
 * Workers RPC disposes a stub received in an RPC method's parameters the moment that call
 * returns. A turn outlives the call that starts it — the call returns a frame stream and the turn
 * keeps producing frames behind it — so the turn cannot hold the received stub. It duplicates the
 * stub and holds this lease on the duplicate instead.
 *
 * `release` is one-shot. Whichever of the turn's three endings reaches it first — the turn
 * completing, the turn failing, or the caller cancelling the frame stream — releases the
 * duplicate, and every later call does nothing. The Workers execution context stays alive while
 * any received stub is undisposed, so a lease that is never released leaks the isolate the turn
 * ran in, not merely a handle.
 */
export interface ProjectCapabilityLease {
  /** The duplicate. Valid until {@link ProjectCapabilityLease.release} runs. */
  readonly capability: ProjectRpcTargetContract;
  readonly released: boolean;
  release(): void;
}

/** The two stub operations a received capability must carry for a turn to be able to own it. */
type DuplicableStub = {
  dup(): ProjectRpcTargetContract & Disposable;
};

// oxlint-disable-next-line anti-slop/no-runtime-typeof -- Boundary: `dup` and the disposer are runtime facts of an RPC stub, not part of the contract type a caller declares.
function isDuplicableStub(
  received: ProjectRpcTargetContract,
): received is DuplicableStub & ProjectRpcTargetContract {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: reads two possibly-absent members off the received value; both are checked before use.
  const stub = received as Partial<DuplicableStub> & Partial<Disposable>;

  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Boundary: see above.
  return typeof stub.dup === "function" && typeof stub[Symbol.dispose] === "function";
}

/**
 * Duplicates a project capability received over RPC and returns the lease on that duplicate, or
 * `undefined` when the received value is not a live RPC stub. A caller that passes a plain object
 * rather than a real capability is rejected here rather than part-way through a turn.
 */
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
