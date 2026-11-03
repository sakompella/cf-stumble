import { RpcTarget } from "cloudflare:workers";
import type { Wake } from "@earendil-works/pi-durable";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { ConversationHost, EntriesRequest, RunningConversation } from "../../facet/index.js";
import {
  GenerationControlRequest,
  GenerationControlTarget,
  GenerationSubmissionRequest,
  generationStatusView,
  type GenerationControl,
  type GenerationOperations,
  type GenerationStatusView,
} from "../../generation-requests.js";
import type { GenerationControlResult, Submission } from "../generations.js";
import type { StartupCheckResult } from "../startup-check/index.js";
import type { ProjectRpcTargetContract } from "../../workspace/project/protocol.js";

export type { EntriesRequest, RunningConversation };

type HostPorts = Readonly<{
  arm: (wake: Wake) => Promise<void>;
  running: (conversations: readonly RunningConversation[]) => Promise<void>;
  workspace: (conversationId: string) => Promise<ProjectRpcTargetContract & Disposable>;
}>;

const WakeFields = Schema.Struct({
  active: Schema.optionalKey(Schema.Unknown),
  at: Schema.optionalKey(Schema.Unknown),
});

const readWakeFields = Schema.decodeUnknownOption(WakeFields);

const isFiniteNumber = Schema.is(Schema.Finite);

const isString = Schema.is(Schema.String);

const isRunningConversations = Schema.is(
  Schema.Array(
    Schema.Struct({ conversationId: Schema.String, run: Schema.optional(Schema.Finite) }),
  ),
);

export class ConversationHostTarget extends RpcTarget implements ConversationHost {
  readonly #ports: HostPorts;

  constructor(ports: HostPorts) {
    super();
    this.#ports = ports;
  }

  arm(wake: Wake): Promise<void> {
    return this.#ports.arm(parseWake(wake));
  }

  running(conversations: readonly RunningConversation[]): Promise<void> {
    if (!isRunningConversations(conversations)) {
      return Promise.reject(new Error("running conversations must be conversation ids and runs"));
    }

    return this.#ports.running(conversations);
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

const STRICT = { onExcessProperty: "error" } as const;

const readSubmission = Schema.decodeUnknownOption(GenerationSubmissionRequest, STRICT);

const readLabel = Schema.decodeUnknownOption(GenerationControlTarget.fields.label);

const readControl = Schema.decodeUnknownOption(GenerationControlRequest, STRICT);

function whenValid<I, A>(input: Option.Option<I>, call: (value: I) => A | Promise<A>): Promise<A> {
  return Option.match(input, {
    onNone: () => Promise.reject(new Error("invalid generation request")),
    onSome: (value) => Promise.resolve(value).then(call),
  });
}

export class GenerationHostTarget extends RpcTarget implements GenerationControl {
  readonly #operations: GenerationOperations;

  constructor(operations: GenerationOperations) {
    super();
    this.#operations = operations;
  }

  async generationStatus(): Promise<GenerationStatusView> {
    return generationStatusView(await this.#operations.getActiveGeneration());
  }

  submitGeneration(harnessCommit: Schema.Json): Promise<Submission> {
    return whenValid(readSubmission({ harnessCommit }), (request) =>
      this.#operations.submitGeneration(request.harnessCommit),
    );
  }

  prepareGeneration(label: Schema.Json): Promise<StartupCheckResult> {
    return whenValid(readLabel(label), (checked) => this.#operations.prepareGeneration(checked));
  }

  controlGeneration(command: Schema.Json): Promise<GenerationControlResult> {
    return whenValid(readControl(command), (checked) =>
      this.#operations.controlGeneration(checked),
    );
  }
}
