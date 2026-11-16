import { ProjectRpcTarget } from "../../../src/workspace/project/index.js";
import type { ProjectRpcTargetOptions } from "../../../src/workspace/project/target.js";
import {
  FakeExecBackend,
  FakeProjectFilesystemProvider,
  FakeProjectTransactions,
} from "./fakes.js";

export function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

const FAR_DEADLINE_MS = 2_000_000_000;

export function targetOptions(overrides: Partial<ProjectRpcTargetOptions> = {}) {
  return {
    remainingMs: FAR_DEADLINE_MS,
    containerState: { generation: 0 },
    activity: { begin: () => () => {}, touch: () => {} },
    endLease: () => {},
    ...overrides,
  } satisfies ProjectRpcTargetOptions;
}

export function projectTarget(
  provider: ConstructorParameters<typeof ProjectRpcTarget>[0],
  execBackend: ConstructorParameters<typeof ProjectRpcTarget>[2],
  overrides: Partial<ProjectRpcTargetOptions> = {},
) {
  return new ProjectRpcTarget(
    provider,
    new FakeProjectTransactions(),
    execBackend,
    targetOptions(overrides),
  );
}

export function makeTarget() {
  const provider = new FakeProjectFilesystemProvider();
  const transactions = new FakeProjectTransactions();
  const execBackend = new FakeExecBackend();
  const target = new ProjectRpcTarget(provider, transactions, execBackend, targetOptions());

  return { provider, transactions, execBackend, target };
}
