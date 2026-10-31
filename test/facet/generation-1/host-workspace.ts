import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { createComputerEnv } from "../../../src/facet/generation-1/execution-env.js";
import { ProjectRpcTarget } from "../../../src/workspace/project/target.js";
import { FakeProjectTransactions } from "../../workspace/project/fakes.js";
import { hostExecBackend, hostFilesystemProvider } from "./host-adapters.js";

export async function withHostWorkspace(use: (env: ExecutionEnv) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "computer-env-"));

  try {
    await mkdir(join(root, "project"));

    const target = new ProjectRpcTarget(
      hostFilesystemProvider(root),
      new FakeProjectTransactions(),
      hostExecBackend(root),
    );

    await use(createComputerEnv({ cwd: "/workspace/project", target }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
