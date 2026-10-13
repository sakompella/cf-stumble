import { ok, type ProjectResult } from "../../../src/workspace/project/protocol.js";
import type {
  ProjectCapabilityStub,
  TurnWorkspace,
} from "../../../src/supervisor/projects/index.js";

/** The workspace of a scripted generation, which runs no command for its end to stop. */
export const idleWorkspace: TurnWorkspace = { end: () => {} };

/** A capability stub for a start whose facet never calls it; its duplicate has nothing to end. */
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: only `dup`, and then `endTurn` and dispose on the duplicate, are ever called.
export const unusedCapability = {
  dup: () => ({
    endTurn: (): Promise<ProjectResult<{ killed: number }>> => Promise.resolve(ok({ killed: 0 })),
    [Symbol.dispose]: () => {},
  }),
} as ProjectCapabilityStub;
