import {
  AgentMaterializationError,
  materializeGeneration,
} from "../agent/runtime/index.js";
import type { Sha } from "../git/types.js";
import type { Store } from "../storage/types.js";

export type PreflightStatus = "PASS" | "FAIL" | "INCONCLUSIVE";

export type PreflightCapability = "materialization" | "read" | "write" | "edit" | "bash" | "self-edit";

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
  readonly failure: string | undefined;
};

export type PreflightOptions = {
  readonly store: Store;
  readonly candidate: Sha;
};

export async function runPreflight(options: PreflightOptions): Promise<PreflightResult> {
  try {
    await materializeGeneration(options.store, options.candidate);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    const status: PreflightStatus =
      error instanceof AgentMaterializationError ? "FAIL" : "INCONCLUSIVE";
    return {
      status,
      checks: [{ capability: "materialization", status, detail }],
      failure: detail,
    };
  }

  return {
    status: "PASS",
    checks: [{ capability: "materialization", status: "PASS" }],
    failure: undefined,
  };
}
