import type { Workspace } from "@cloudflare/computer";
import { WORKSPACE_OUTPUT_OPTIONS } from "../../../infra/worker-settings.js";
import { WORKSPACE_SPILL_DIRECTORY } from "../../workspace-layout.js";

const SPILL_FILE_NAME = /^pi-output-[0-9a-f]{32}\.log$/u;

export async function pruneWorkspaceSpills(workspace: Workspace): Promise<void> {
  const entries = await workspace.fs.readdir(WORKSPACE_SPILL_DIRECTORY).catch(() => []);

  const stale = entries
    .filter((entry) => entry.isFile && SPILL_FILE_NAME.test(entry.name))
    .toSorted((left, right) => right.mtime - left.mtime)
    .slice(WORKSPACE_OUTPUT_OPTIONS.keep);

  await Promise.allSettled(
    stale.map((entry) =>
      workspace.fs.rm(`${WORKSPACE_SPILL_DIRECTORY}/${entry.name}`, { force: true }),
    ),
  );
}
