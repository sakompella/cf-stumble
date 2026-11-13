import * as Effect from "effect/Effect";
import {
  generationStatusView,
  type ActiveGeneration,
  type OwnerStatus,
} from "../../generation-requests.js";
import type { HarnessCommit } from "../../harness-commit.js";
import { runAtEntryPoint } from "../../run-entry-point.js";
import { boundedRpc, WORKSPACE_SHORT_RPC_TIMEOUT_MS } from "../../workspace-command-timeout.js";
import {
  UNKNOWN_LINEAGE,
  type HarnessLineage,
  type WorkspaceHostRpc,
} from "../../workspace/index.js";

const MAIN_AHEAD_KEY = "main-ahead";

type MainAhead = Readonly<{ harnessCommit: string; count: number }>;

export class MainLineage {
  readonly #kv: SyncKvStorage;
  readonly #workspace: () => WorkspaceHostRpc<"lineage">;

  constructor(kv: SyncKvStorage, workspace: () => WorkspaceHostRpc<"lineage">) {
    this.#kv = kv;
    this.#workspace = workspace;
  }

  read(activeCommit: HarnessCommit, harnessCommit: HarnessCommit): Promise<HarnessLineage> {
    return runAtEntryPoint(
      boundedRpc(
        () => this.#workspace().lineage({ activeCommit, harnessCommit }),
        WORKSPACE_SHORT_RPC_TIMEOUT_MS,
      ).pipe(Effect.orElseSucceed(() => UNKNOWN_LINEAGE)),
    );
  }

  record(harnessCommit: HarnessCommit, count: number | undefined): void {
    if (count === undefined) {
      this.#kv.delete(MAIN_AHEAD_KEY);
    } else {
      this.#kv.put(MAIN_AHEAD_KEY, { harnessCommit, count } satisfies MainAhead);
    }
  }

  status(active: ActiveGeneration): OwnerStatus {
    const stored = this.#kv.get<MainAhead>(MAIN_AHEAD_KEY);
    const known = stored !== undefined && stored.harnessCommit === active.generation?.harnessCommit;

    return {
      activeGeneration: generationStatusView(active),
      mainAhead: known ? stored.count : null,
    };
  }
}
