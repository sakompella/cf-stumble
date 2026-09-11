import { ProjectRpcTarget } from "../../../src/workspace/project/index.js";
import { createFacetExecutionEnv } from "../../../src/facet/generation-0/execution-env.js";
import {
  FakeExecBackend,
  FakeProjectFilesystemProvider,
  FakeProjectTransactions,
} from "../../workspace/project/fakes.js";

/**
 * One request-scoped target and the facet `ExecutionEnv` built on it, matching the shape a Dynamic
 * Worker facet would receive: a real `ProjectRpcTarget` (not a hand-rolled fake target), backed by
 * an in-memory filesystem and a scripted exec backend so every test stays deterministic.
 */
export function makeFacetExecutionEnv(cwd = "/workspace") {
  const provider = new FakeProjectFilesystemProvider();
  const transactions = new FakeProjectTransactions();
  const execBackend = new FakeExecBackend();
  const projectTarget = new ProjectRpcTarget(provider, transactions, execBackend);
  const env = createFacetExecutionEnv({ cwd, projectTarget });

  return { provider, transactions, execBackend, projectTarget, env };
}

export function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}
