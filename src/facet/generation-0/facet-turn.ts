import { createFacetExecutionEnv, PROJECT_ROOT } from "./execution-env.js";
import { parseFacetTurnRequest, type FacetTurnRequest } from "./facet-turn-request.js";
import { createPiAgentTurnState, runPiAgentTurn } from "./pi-agent-turn.js";
import { leaseProjectCapability, type ProjectCapabilityLease } from "./project-capability.js";
import { createRouteStreamFn, ROUTE_MODEL } from "./route-stream.js";
import type { AgentEvent } from "@cf-stumble/pi";
import type { ProjectRpcTargetContract } from "../../workspace/project/protocol.js";
import type { Generation0Capabilities } from "./capabilities.js";
import type { PiAgentTurnOutcome, PiAgentTurnState } from "./pi-agent-turn.js";

export type { FacetTurnRequest } from "./facet-turn-request.js";

/**
 * One frame of a turn's byte stream. `completed` and `failed` both carry the Pi state the next
 * turn continues from, because a turn that hit its model-call limit or a model error still
 * produced conversation the thread must keep. `rejected` carries none: no turn ran.
 */
export type FacetTurnFrame =
  | Readonly<{ kind: "text"; text: string }>
  | Readonly<{ kind: "tool-result"; toolCallId: string; toolName: string; isError: boolean }>
  | Readonly<{ kind: "completed"; state: PiAgentTurnState }>
  | Readonly<{ kind: "failed"; code: "model-call-limit" | "model-error"; state: PiAgentTurnState }>
  | Readonly<{ kind: "rejected"; code: "invalid-project-capability" | "invalid-turn-request" }>;

const encoder = new TextEncoder();

function encodeFrame(frame: FacetTurnFrame): Uint8Array {
  return encoder.encode(`${JSON.stringify(frame)}\n`);
}

function outcomeFrame(outcome: PiAgentTurnOutcome): FacetTurnFrame {
  return outcome.ok
    ? { kind: "completed", state: outcome.state }
    : { kind: "failed", code: outcome.problem.code, state: outcome.state };
}

/** The frames one Pi lifecycle event publishes, if any. Only whole messages are published. */
function eventFrames(event: AgentEvent): readonly FacetTurnFrame[] {
  if (event.type !== "message_end") return [];
  const { message } = event;
  if (message.role === "toolResult") {
    return [
      {
        kind: "tool-result",
        toolCallId: message.toolCallId,
        toolName: message.toolName,
        isError: message.isError,
      },
    ];
  }
  if (message.role !== "assistant") return [];
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => ({ kind: "text", text: block.text }));
}

async function pumpTurn(
  capabilities: Generation0Capabilities,
  lease: ProjectCapabilityLease,
  request: FacetTurnRequest,
  signal: AbortSignal,
  publish: (frame: FacetTurnFrame) => void,
): Promise<void> {
  const outcome = await runPiAgentTurn({
    prompt: request.prompt,
    state: request.state ?? createPiAgentTurnState(ROUTE_MODEL),
    env: createFacetExecutionEnv({ cwd: PROJECT_ROOT, projectTarget: lease.capability }),
    streamFn: createRouteStreamFn(capabilities.MODEL, signal),
    onEvent: (event) => {
      for (const frame of eventFrames(event)) publish(frame);
    },
    signal,
  });
  publish(outcomeFrame(outcome));
}

/**
 * Runs one turn against a project capability received as an RPC method argument, and returns the
 * newline-delimited JSON frames it produces.
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
        await pumpTurn(capabilities, lease, parsed, cancellation.signal, publish);
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
