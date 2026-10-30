import { createFacetExecutionEnv } from "./execution-env.js";
import { parseFacetTurnRequest, type FacetTurnRequest } from "./facet-turn-request.js";
import { createPiAgentTurnState, runPiAgentTurn } from "./pi-agent-turn.js";
import { leaseProjectCapability, type ProjectCapabilityLease } from "./project-capability.js";
import { createRouteStreamFn, ROUTE_MODEL } from "./route-stream.js";
import { TurnFrames } from "./turn-frames.js";
import { PROJECT_TURN_DEADLINE_MS } from "../../turn-budget.js";
import { mutatesWorkspace, readWorkspaceDiff } from "./workspace-diff.js";
import type { ProjectRpcTargetContract } from "../../workspace/project/protocol.js";
import type { Generation0Capabilities } from "./capabilities.js";
import type { PiAgentTurnOutcome } from "./pi-agent-turn.js";
import type { FacetTurnFrame } from "./turn-frames.js";
import type { WorkspaceDiff } from "./workspace-diff.js";

export type { FacetTurnRequest } from "./facet-turn-request.js";

export type { FacetTurnFrame } from "./turn-frames.js";

const encoder = new TextEncoder();

function encodeFrame(frame: FacetTurnFrame): Uint8Array {
  return encoder.encode(`${JSON.stringify(frame)}\n`);
}

function outcomeFrame(outcome: PiAgentTurnOutcome): FacetTurnFrame {
  return outcome.ok
    ? { kind: "completed", state: outcome.state }
    : { kind: "failed", code: outcome.problem.code, state: outcome.state };
}

function diffFrame(diff: WorkspaceDiff): FacetTurnFrame {
  return diff.available
    ? { kind: "diff", content: diff.content, truncated: diff.truncated }
    : { kind: "diff-unavailable", detail: diff.detail };
}

async function pumpTurn(
  capabilities: Generation0Capabilities,
  lease: ProjectCapabilityLease,
  request: FacetTurnRequest,
  workingDirectory: string,
  signal: AbortSignal,
  deadlineAt: number,
  now: () => number,
  publish: (frame: FacetTurnFrame) => void,
): Promise<void> {
  const frames = new TurnFrames();

  const env = createFacetExecutionEnv({
    cwd: workingDirectory,
    projectTarget: lease.capability,
    turnDeadlineAt: deadlineAt,
    now,
  });

  let touchedFiles = false;

  const outcome = await runPiAgentTurn({
    prompt: request.prompt,
    state: { ...createPiAgentTurnState(ROUTE_MODEL), messages: [...request.messages] },
    env,
    streamFn: createRouteStreamFn(capabilities.MODEL, signal),
    onEvent: (event) => {
      for (const frame of frames.frames(event)) {
        if (frame.kind === "tool-start" && mutatesWorkspace(frame.toolName)) touchedFiles = true;
        publish(frame);
      }
    },
    signal,
  });

  // Asked for after the model stops, so a turn that used a file-changing tool shows what changed even
  // if the model never said; a failed turn gets one too.
  if (touchedFiles && !signal.aborted) {
    publish(diffFrame(await readWorkspaceDiff(env, signal)));
  }

  publish(outcomeFrame(outcome));
}

/**
 * The capability is request-scoped because the Worker Loader caches this environment per harness
 * commit. The turn runs after the starting RPC call returned, so it leases a duplicate; Workers RPC
 * disposes the received stub at that moment. The lease is released on finish, throw, and cancel, and
 * cancel also aborts the run.
 */
// oxlint-disable-next-line max-lines-per-function -- The stream lifecycle keeps parsing, leasing, and cancellation in one boundary.
export function startFacetTurn(
  capabilities: Generation0Capabilities,
  received: ProjectRpcTargetContract,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Boundary: the turn request arrives over RPC, so it has no proven shape here.
  request: unknown,
  workingDirectory: string,
  now: () => number = Date.now,
): ReadableStream<Uint8Array> {
  const deadlineAt = now() + PROJECT_TURN_DEADLINE_MS;
  const cancellation = new AbortController();
  let lease: ProjectCapabilityLease | undefined;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const publish = (frame: FacetTurnFrame) => {
        if (cancellation.signal.aborted) return;
        controller.enqueue(encodeFrame(frame));
      };

      const close = () => {
        if (!cancellation.signal.aborted) controller.close();
      };

      const parsed = parseFacetTurnRequest(request);

      if (parsed === undefined) {
        publish({ kind: "rejected", code: "invalid-turn-request" });
        close();

        return;
      }

      lease = leaseProjectCapability(received);

      if (lease === undefined) {
        publish({ kind: "rejected", code: "invalid-project-capability" });
        close();

        return;
      }

      try {
        await pumpTurn(
          capabilities,
          lease,
          parsed,
          workingDirectory,
          cancellation.signal,
          deadlineAt,
          now,
          publish,
        );
        close();
      } catch (error) {
        if (!cancellation.signal.aborted) controller.error(error);
      } finally {
        lease.release();
      }
    },
    cancel() {
      cancellation.abort();
      // A turn stops when the capability it calls through goes away, so releasing it also ends the work.
      lease?.release();
    },
  });
}
