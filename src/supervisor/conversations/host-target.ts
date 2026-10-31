import { RpcTarget } from "cloudflare:workers";
import type { Wake } from "@earendil-works/pi-durable";
import type { ConversationHost } from "../../facet/index.js";
import type { ProjectRpcTargetContract } from "../../workspace/project/protocol.js";

type HostPorts = Readonly<{
  arm: (wake: Wake) => Promise<void>;
  workspace: (conversationId: string) => Promise<ProjectRpcTargetContract & Disposable>;
}>;

export class ConversationHostTarget extends RpcTarget implements ConversationHost {
  readonly #ports: HostPorts;

  constructor(ports: HostPorts) {
    super();
    this.#ports = ports;
  }

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Boundary: the wake arrives over RPC.
  arm(wake: unknown): Promise<void> {
    return this.#ports.arm(parseWake(wake));
  }

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Boundary: the conversation id arrives over RPC.
  workspace(conversationId: unknown): Promise<ProjectRpcTargetContract & Disposable> {
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Boundary: untrusted RPC argument.
    if (typeof conversationId !== "string") {
      return Promise.reject(new Error("no workspace for this request"));
    }

    return this.#ports.workspace(conversationId);
  }
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Boundary: see `arm`.
function parseWake(wake: unknown): Wake {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Boundary: untrusted RPC argument.
  if (wake === null || typeof wake !== "object") return { active: true };
  // SAFETY: both fields are read as `unknown` and checked below.
  const { active, at } = wake as { active?: unknown; at?: unknown };

  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Boundary: untrusted RPC argument.
  return typeof at === "number" && Number.isFinite(at)
    ? { active: active !== false, at }
    : { active: active !== false };
}
