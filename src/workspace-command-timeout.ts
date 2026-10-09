/**
 * How long one planned workspace command may run.
 *
 * Computer's own default killed `pnpm install` inside the deployed container after about a minute
 * and reported an exit code the command never chose, so every planned command names this instead.
 * The value is the cold-build budget `docs/agents/design/computer-integration.md` records: an
 * install of 186 packages from the registry, on a container filesystem served by Computer's
 * userspace shim, is minutes rather than seconds. A clone gets the same budget because it is the
 * same kind of work over the same network.
 */
export const WORKSPACE_COMMAND_TIMEOUT_MS = 900_000;

/** Time reserved for an RPC to settle after its container command ceiling. */
export const WORKSPACE_RPC_TIMEOUT_MARGIN_MS = 1_000;

/** The longest one Workspace Host RPC may run: the command ceiling plus its settling margin. */
export const WORKSPACE_RPC_TIMEOUT_MS =
  WORKSPACE_COMMAND_TIMEOUT_MS + WORKSPACE_RPC_TIMEOUT_MARGIN_MS;
