import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { ConversationHost } from "../conversation-protocol.js";
import { createComputerEnv } from "./execution-env.js";

export async function computerEnv(
  host: ConversationHost,
  conversationId: string,
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<ExecutionEnv> {
  const target = await host.workspace(conversationId);
  const env = createComputerEnv({ cwd, target });

  const end = () => {
    void env.cleanup(BACKGROUND_CONTEXT).finally(() => {
      target[Symbol.dispose]();
    });
  };

  if (signal?.aborted === true) end();
  else signal?.addEventListener("abort", end, { once: true });

  return env;
}
