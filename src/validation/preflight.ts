import { Result } from "better-result";
import {
  materializeGeneration,
  type SYSTEM_PROMPT_PATH,
  type AgentDefinition,
  type AgentExecutorOptions,
  type ModelResponseSource,
} from "../agent/runtime/index.js";
import type { Sha } from "../git/types.js";
import type { Workspace } from "../tools/index.js";
import { StorageUnavailableError } from "../storage/errors.js";
import type { Store } from "../storage/types.js";
import { probes } from "./preflight-probes.js";
import { runProbe } from "./preflight-execution.js";

export type PreflightStatus = "PASS" | "FAIL" | "INCONCLUSIVE";

export type PreflightCapability =
  | "materialization"
  | "read"
  | "write"
  | "edit"
  | "bash"
  | "self-edit";

export type PreflightCheck =
  | { readonly capability: PreflightCapability; readonly status: "PASS" }
  | {
      readonly capability: PreflightCapability;
      readonly status: "FAIL" | "INCONCLUSIVE";
      readonly detail: string;
    };

export type PreflightResult = {
  readonly status: PreflightStatus;
  readonly checks: readonly PreflightCheck[];
  readonly failure?: string;
};

export type PreflightProbe =
  | { readonly capability: "read"; readonly path: "preflight/read.txt"; readonly content: string }
  | {
      readonly capability: "write";
      readonly path: "preflight/write.txt";
      readonly content: string;
    }
  | {
      readonly capability: "edit";
      readonly path: "preflight/edit.txt";
      readonly initialContent: string;
      readonly oldText: string;
      readonly newText: string;
    }
  | { readonly capability: "bash"; readonly command: "printf 'preflight\\n'" }
  | {
      readonly capability: "self-edit";
      readonly path: typeof SYSTEM_PROMPT_PATH;
      readonly suffix: string;
    };

export type PreflightWorkspaceFactory = (
  probe: PreflightProbe,
  definition: AgentDefinition,
) => Workspace | Promise<Workspace>;

export type PreflightResponseSourceFactory = (
  probe: PreflightProbe,
  definition: AgentDefinition,
) => ModelResponseSource | Promise<ModelResponseSource>;

export type PreflightRunner = (candidate: Sha) => Promise<PreflightResult>;

export type PreflightOptions = {
  readonly store: Store;
  readonly candidate: Sha;
  readonly executorOptions?: AgentExecutorOptions;
  readonly workspaceFactory?: PreflightWorkspaceFactory;
  readonly responseSourceFactory?: PreflightResponseSourceFactory;
  readonly timeoutMs?: number;
  readonly nowMs?: number;
};

const PREFLIGHT_TIMEOUT_MS = 1_000;
const PREFLIGHT_NOW_MS = 1_700_000_000_000;

export async function runPreflight(options: PreflightOptions): Promise<PreflightResult> {
  let definition: AgentDefinition;
  try {
    const materialized = await materializeGeneration(options.store, options.candidate);
    if (Result.isError(materialized)) {
      const detail = materialized.error.message;
      const status = StorageUnavailableError.is(materialized.error) ? "INCONCLUSIVE" : "FAIL";
      return {
        status,
        checks: [{ capability: "materialization", status, detail }],
        failure: detail,
      };
    }
    definition = materialized.value;
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      status: "INCONCLUSIVE",
      checks: [{ capability: "materialization", status: "INCONCLUSIVE", detail }],
      failure: detail,
    };
  }

  const materialization: PreflightCheck = {
    capability: "materialization",
    status: "PASS",
  };
  const timeoutMs = options.timeoutMs ?? PREFLIGHT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    const detail = `preflight: timeout must be positive and finite, got ${timeoutMs}`;
    return {
      status: "INCONCLUSIVE",
      checks: [materialization, ...probes.map((probe) => inconclusiveTimeout(probe, detail))],
      failure: detail,
    };
  }

  const checks: PreflightCheck[] = [materialization];
  for (const probe of probes) {
    checks.push(
      await runProbe(definition, probe, options, timeoutMs, options.nowMs ?? PREFLIGHT_NOW_MS),
    );
  }

  const failure = checks.find((check) => check.status !== "PASS");
  if (failure === undefined) {
    return { status: "PASS", checks };
  }
  return { status: failure.status, checks, failure: failure.detail };
}

function inconclusiveTimeout(probe: PreflightProbe, detail: string): PreflightCheck {
  return { capability: probe.capability, status: "INCONCLUSIVE", detail };
}
