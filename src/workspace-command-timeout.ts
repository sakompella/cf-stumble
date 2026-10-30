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

/**
 * How long a credential install, logout, status read, or repository check may run. They are one
 * `gh` or `git` call each, so a hang is a network fault that should fail fast instead of holding
 * the Workspace Host's tracked work, and with it the idle stop, for the full command ceiling.
 */
export const WORKSPACE_SHORT_COMMAND_TIMEOUT_MS = 60_000;

/** Time reserved for an RPC to settle after its container command ceiling. */
export const WORKSPACE_RPC_TIMEOUT_MARGIN_MS = 1_000;

/** The longest one Workspace Host RPC may run: the command ceiling plus its settling margin. */
export const WORKSPACE_RPC_TIMEOUT_MS =
  WORKSPACE_COMMAND_TIMEOUT_MS + WORKSPACE_RPC_TIMEOUT_MARGIN_MS;

/** The longest one short Workspace Host RPC may run. */
export const WORKSPACE_SHORT_RPC_TIMEOUT_MS =
  WORKSPACE_SHORT_COMMAND_TIMEOUT_MS + WORKSPACE_RPC_TIMEOUT_MARGIN_MS;

/**
 * Wait at most `timeoutMs` for one Workspace Host RPC. A container command cannot be interrupted by
 * an AbortSignal, so this only stops waiting; the Host still owns the command and is expected to
 * stop it at the same ceiling.
 */
export async function boundedRpc<T>(run: () => Promise<T>, timeoutMs: number): Promise<T> {
  const operation = run();

  // The RPC may reject after the timeout has already settled the race.
  void operation.catch(() => {});

  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error("Workspace Host RPC timed out");
      error.name = "TimeoutError";
      reject(error);
    }, timeoutMs);
  });

  try {
    return await Promise.race([operation, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
