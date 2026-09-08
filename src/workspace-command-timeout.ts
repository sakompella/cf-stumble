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
