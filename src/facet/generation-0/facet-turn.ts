import { createFacetExecutionEnv } from "./execution-env.js";
import { parseFacetTurnRequest, type FacetTurnRequest } from "./facet-turn-request.js";
import { createPiAgentTurnState, runPiAgentTurn } from "./pi-agent-turn.js";
import { leaseProjectCapability, type ProjectCapabilityLease } from "./project-capability.js";
import { createRouteStreamFn, ROUTE_MODEL } from "./route-stream.js";
import { TurnFrames } from "./turn-frames.js";
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
  publish: (frame: FacetTurnFrame) => void,
): Promise<void> {
  const frames = new TurnFrames();
  const env = createFacetExecutionEnv({ cwd: workingDirectory, projectTarget: lease.capability });
  let touchedFiles = false;

  const outcome = await runPiAgentTurn({
    prompt: request.prompt,
    // The conversation arrives from the host's saved thread; everything else about the state is
    // this generation's own, so it is built here rather than accepted from a request.
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

  // The turn's own diff, asked for here rather than in the system prompt (goal criterion 4). It
  // runs after the model has stopped and before the terminal frame, so a turn that used a tool
  // which can change a file ends by showing what changed even when the model never mentioned it.
  // A failed turn gets one too: it may have changed files before it failed.
  if (touchedFiles && !signal.aborted) {
    publish(diffFrame(await readWorkspaceDiff(env, signal)));
  }

  publish(outcomeFrame(outcome));
}

/**
 * Runs one turn against a workspace capability received as an RPC method argument, starting in the
 * working directory the host selected, and returns the newline-delimited JSON frames it produces.
 *
 * The capability is request-scoped by construction. It never reaches this generation's
 * environment, which the Worker Loader caches per harness commit and which therefore cannot hold
 * anything belonging to one project. The stream is returned before the turn starts, so the turn
 * runs after the RPC call that started it has already returned; that is why it holds a lease on a
 * duplicate rather than the received stub, which Workers RPC disposes at that moment.
 *
 * The lease is released on all three of the turn's endings: the turn finishing, the turn throwing,
 * and the caller cancelling this stream. The last one also aborts the run, so a caller that stops
 * reading stops the work rather than merely stopping the frames.
 */
export function startFacetTurn(
  capabilities: Generation0Capabilities,
  received: ProjectRpcTargetContract,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Boundary: the turn request arrives over RPC, so it has no proven shape here.
  request: unknown,
  workingDirectory: string,
): ReadableStream<Uint8Array> {
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
        await pumpTurn(capabilities, lease, parsed, workingDirectory, cancellation.signal, publish);
        close();
      } catch (error) {
        if (!cancellation.signal.aborted) controller.error(error);
      } finally {
        lease.release();
      }
    },
    cancel() {
      cancellation.abort();
      // Released here rather than left to the pump: a turn stops when the capability it is
      // calling through goes away, so this both frees the stub and ends the work behind it.
      lease?.release();
    },
  });
}
