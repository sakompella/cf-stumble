import { AgentExecutor, type AgentDefinition } from "../agent/runtime/index.js";
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
    const result = await withTimeout(executeProbe(definition, probe, options, nowMs), timeoutMs);
    if (result === timeoutMarker) {
      return inconclusive(probe.capability, `probe exceeded ${timeoutMs}ms`);
    }
    return result;
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    return inconclusive(probe.capability, `harness error: ${detail}`);
  }
}

async function executeProbe(
  definition: AgentDefinition,
  probe: PreflightProbe,
  options: PreflightOptions,
  nowMs: number,
): Promise<PreflightCheck> {
  const workspace = await (options.workspaceFactory ?? defaultWorkspace)(probe, definition);
  const source = await (options.responseSourceFactory ?? defaultResponseSource)(probe, definition);
  const turn = await new AgentExecutor(definition, options.executorOptions).executeTurn(
    `preflight ${probe.capability}`,
    source,
    workspace,
    {
      name: `preflight-${probe.capability}`,
      seed: 0,
      nowMs,
    },
  );
  if (turn.status === "failed") {
    return failedTurn(probe.capability, turn.failure);
  }
  return verifyProbe(probe, definition, turn, workspace);
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
