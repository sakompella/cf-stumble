import { RpcTarget } from "cloudflare:workers";
import type { Wake } from "@earendil-works/pi-durable";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { ConversationHost } from "../../facet/index.js";
import type { ProjectRpcTargetContract } from "../../workspace/project/protocol.js";

type HostPorts = Readonly<{
  arm: (wake: Wake) => Promise<void>;
  running: (conversationIds: readonly string[]) => Promise<void>;
  workspace: (conversationId: string) => Promise<ProjectRpcTargetContract & Disposable>;
}>;

const WakeFields = Schema.Struct({
  active: Schema.optionalKey(Schema.Unknown),
  at: Schema.optionalKey(Schema.Unknown),
});

const readWakeFields = Schema.decodeUnknownOption(WakeFields);

const isFiniteNumber = Schema.is(Schema.Finite);

const isString = Schema.is(Schema.String);

const isConversationIds = Schema.is(Schema.Array(Schema.String));

export class ConversationHostTarget extends RpcTarget implements ConversationHost {
  readonly #ports: HostPorts;

  constructor(ports: HostPorts) {
    super();
    this.#ports = ports;
  }

  arm(wake: Wake): Promise<void> {
    return this.#ports.arm(parseWake(wake));
  }

  running(conversationIds: readonly string[]): Promise<void> {
    if (!isConversationIds(conversationIds)) {
      return Promise.reject(new Error("running conversations must be conversation ids"));
    }

    return this.#ports.running(conversationIds);
  }

  workspace(conversationId: string): Promise<ProjectRpcTargetContract & Disposable> {
    if (!isString(conversationId)) {
      return Promise.reject(new Error("no workspace for this request"));
    }

    return this.#ports.workspace(conversationId);
  }
}

function parseWake(wake: Wake): Wake {
  return Option.match(readWakeFields(wake), {
    onNone: () => ({ active: true }),
    onSome: ({ active, at }) =>
      isFiniteNumber(at) ? { active: active !== false, at } : { active: active !== false },
  });
}
