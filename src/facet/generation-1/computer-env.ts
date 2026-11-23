import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  hostLog,
  type ConversationHost,
  type GenerationControl,
  type TailnetFetch,
} from "../conversation-protocol.js";
import { createComputerEnv, type ComputerEnv } from "./execution-env.js";

export async function computerEnv(
  host: ConversationHost,
  generations: GenerationControl,
  conversationId: string,
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<ComputerEnv> {
  const target = await host.workspace(conversationId);

  const tailnetFetch: TailnetFetch = (url, init) =>
    host.tailnetFetch === undefined
      ? Promise.reject(new Error("this host provides no tailnet"))
      : host.tailnetFetch(url, init);

  const env = createComputerEnv({ cwd, target, generations, log: hostLog(host), tailnetFetch });

  const end = () => {
    void env.cleanup(BACKGROUND_CONTEXT).finally(() => {
      target[Symbol.dispose]();
    });
  };

  if (signal?.aborted === true) end();
  else signal?.addEventListener("abort", end, { once: true });

  return env;
}
