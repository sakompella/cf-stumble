export const WORKSPACE_COMMAND_TIMEOUT_MS = 900_000;

export const WORKSPACE_SHORT_COMMAND_TIMEOUT_MS = 60_000;

const WORKSPACE_RPC_TIMEOUT_MARGIN_MS = 1_000;

export const WORKSPACE_RPC_TIMEOUT_MS =
  WORKSPACE_COMMAND_TIMEOUT_MS + WORKSPACE_RPC_TIMEOUT_MARGIN_MS;

export const WORKSPACE_SHORT_RPC_TIMEOUT_MS =
  WORKSPACE_SHORT_COMMAND_TIMEOUT_MS + WORKSPACE_RPC_TIMEOUT_MARGIN_MS;

export async function boundedRpc<T>(run: () => Promise<T>, timeoutMs: number): Promise<T> {
  const operation = run();

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
