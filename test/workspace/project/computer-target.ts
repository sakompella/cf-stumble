import type { Workspace } from "@cloudflare/computer";
import {
  computerExecBackend,
  computerFilesystemProvider,
  durableObjectTransactions,
} from "../../../src/workspace/project/computer-adapter.js";
import { CONTAINER_BACKEND_ID } from "../../../src/workspace/project/exec-backend.js";
import { ProjectRpcTarget } from "../../../src/workspace/project/target.js";
import { targetOptions } from "./target-helpers.js";

export function computerTarget(workspace: Workspace, storage: DurableObjectStorage) {
  return new ProjectRpcTarget(
    computerFilesystemProvider(workspace),
    durableObjectTransactions(storage),
    computerExecBackend(workspace, CONTAINER_BACKEND_ID, { generation: 0 }),
    targetOptions(),
  );
}
