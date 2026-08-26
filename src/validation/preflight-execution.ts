import { AgentExecutor, type AgentDefinition, type TurnResult } from "../agent/runtime/index.js";
import type { PreflightOptions, PreflightProbe, PreflightCheck } from "./preflight.js";
import { defaultResponseSource, defaultWorkspace } from "./preflight-probes.js";
import { failedTurn, verifyProbe } from "./preflight-results.js";

const timeoutMarker = Symbol("preflight-timeout");
type TimeoutMarker = typeof timeoutMarker;

type ProbeCapability = Exclude<PreflightProbe["capability"], "materialization">;

export async function runProbe(
  definition: AgentDefinition,
  probe: PreflightProbe,
  options: PreflightOptions,
  timeoutMs: number,
  nowMs: number,
): Promise<PreflightCheck> {
  try {
    const workspace = await (options.workspaceFactory ?? defaultWorkspace)(probe, definition);
    const source = await (options.responseSourceFactory ?? defaultResponseSource)(
      probe,
      definition,
    );
    const turn = await withTimeout(
      new AgentExecutor(definition, options.executorOptions).executeTurn(
        `preflight ${probe.capability}`,
        source,
        workspace,
        {
          name: `preflight-${probe.capability}`,
          seed: 0,
          nowMs,
        },
      ),
      timeoutMs,
    );
    if (turn === timeoutMarker) {
      return inconclusive(probe.capability, `executor exceeded ${timeoutMs}ms`);
    }
    if (turn.status === "failed") {
      return failedTurn(probe.capability, turn.failure);
    }
    return await verifyProbe(probe, definition, turn, workspace);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    return inconclusive(probe.capability, `harness error: ${detail}`);
  }
}

function inconclusive(capability: ProbeCapability, detail: string): PreflightCheck {
  return { capability, status: "INCONCLUSIVE", detail: `${capability}: ${detail}` };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | TimeoutMarker> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<TimeoutMarker>((resolve) => {
    timer = setTimeout(() => {
      resolve(timeoutMarker);
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  });
}

export type { TurnResult };
