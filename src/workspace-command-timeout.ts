/**
 * Computer's default killed `pnpm install` after about a minute with an exit code the command never
 * chose, so every planned command names its own timeout. Sized for a cold install over Computer's
 * userspace filesystem; a clone gets the same.
 */
export const WORKSPACE_COMMAND_TIMEOUT_MS = 900_000;

/**
 * One `gh` or `git` call each, so a hang is a network fault that should fail fast instead of
 * holding the Host's tracked work, and with it the idle stop.
 */
export const WORKSPACE_SHORT_COMMAND_TIMEOUT_MS = 60_000;

export const WORKSPACE_RPC_TIMEOUT_MARGIN_MS = 1_000;

export const WORKSPACE_RPC_TIMEOUT_MS =
  WORKSPACE_COMMAND_TIMEOUT_MS + WORKSPACE_RPC_TIMEOUT_MARGIN_MS;

export const WORKSPACE_SHORT_RPC_TIMEOUT_MS =
  WORKSPACE_SHORT_COMMAND_TIMEOUT_MS + WORKSPACE_RPC_TIMEOUT_MARGIN_MS;

/**
 * A container command cannot be interrupted by an AbortSignal, so this only stops waiting; the Host
 * stops the command at the same ceiling.
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
