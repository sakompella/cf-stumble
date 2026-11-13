import { RpcTarget } from "cloudflare:workers";
import type { Wake } from "@earendil-works/pi-durable";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type {
  ConversationHost,
  EntriesRequest,
  FacetLogFields,
  FacetLogLevel,
  RunFailures,
  RunningConversation,
} from "../../facet/index.js";
import {
  GenerationControlRequest,
  GenerationControlTarget,
  GenerationSubmissionRequest,
  generationStatusView,
  type GenerationControl,
  type GenerationOperations,
  type GenerationStatusView,
} from "../../generation-requests.js";
import { whileServing } from "../../generation-replaced.js";
import type { GenerationControlResult, Submission } from "../generations.js";
import type { StartupCheckResult } from "../startup-check/index.js";
import type { ProjectRpcTargetContract } from "../../workspace/project/protocol.js";

export type { EntriesRequest, RunningConversation };

export type RunReport = Readonly<{
  running: readonly RunningConversation[];
  failed: RunFailures;
}>;

type HostPorts = Readonly<{
  arm: (wake: Wake) => Promise<void>;
  log: (level: FacetLogLevel, event: string, fields: FacetLogFields) => void;
  running: (report: RunReport) => Promise<void>;
  workspace: (conversationId: string) => Promise<ProjectRpcTargetContract & Disposable>;
}>;

const WakeFields = Schema.Struct({
  active: Schema.optionalKey(Schema.Unknown),
  at: Schema.optionalKey(Schema.Unknown),
});

const readWakeFields = Schema.decodeUnknownOption(WakeFields);

const isFiniteNumber = Schema.is(Schema.Finite);

const isString = Schema.is(Schema.String);

const isLogLevel = Schema.is(Schema.Literals(["info", "error"]));

const isLogFields = Schema.is(
  Schema.Record(
    Schema.String,
    Schema.Union([Schema.String, Schema.Finite, Schema.Boolean, Schema.Null]),
  ),
);

const ReportedRun = Schema.Struct({
  conversationId: Schema.String,
  run: Schema.optional(Schema.Finite),
  continues: Schema.optional(Schema.Finite),
});

const isRunningConversations = Schema.is(Schema.Array(ReportedRun));

export const isContinuedRun = Schema.is(ReportedRun);

const isRunFailures = Schema.is(Schema.Record(Schema.String, Schema.String));

export class ConversationHostTarget extends RpcTarget implements ConversationHost {
  readonly #ports: HostPorts;

  constructor(ports: HostPorts) {
    super();
    this.#ports = ports;
  }

  arm(wake: Wake): Promise<void> {
    return this.#ports.arm(parseWake(wake));
  }

  log(level: FacetLogLevel, event: string, fields: FacetLogFields): Promise<void> {
    if (!isLogLevel(level) || !isString(event) || !isLogFields(fields)) {
      return Promise.reject(new Error("a log must be a level, an event name and plain fields"));
    }

    this.#ports.log(level, event, fields);

    return Promise.resolve();
  }

  running(conversations: readonly RunningConversation[], failed?: RunFailures): Promise<void> {
    if (
      !isRunningConversations(conversations) ||
      (failed !== undefined && !isRunFailures(failed))
    ) {
      return Promise.reject(new Error("running conversations must be conversation ids and runs"));
    }

    return this.#ports.running({ running: conversations, failed: failed ?? {} });
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
  readonly #serves: () => boolean;

  constructor(operations: GenerationOperations, serves: () => boolean) {
    super();
    this.#operations = operations;
    this.#serves = serves;
  }

  generationStatus(): Promise<GenerationStatusView> {
    return whileServing(this.#serves, async () =>
      generationStatusView(await this.#operations.getActiveGeneration()),
    );
  }

  submitGeneration(harnessCommit: Schema.Json): Promise<Submission> {
    return whileServing(this.#serves, () =>
      whenValid(readSubmission({ harnessCommit }), (request) =>
        this.#operations.submitGeneration(request.harnessCommit),
      ),
    );
  }

  prepareGeneration(label: Schema.Json): Promise<StartupCheckResult> {
    return whileServing(this.#serves, () =>
      whenValid(readLabel(label), (checked) => this.#operations.prepareGeneration(checked)),
    );
  }

  controlGeneration(command: Schema.Json): Promise<GenerationControlResult> {
    return whileServing(this.#serves, () =>
      whenValid(readControl(command), (checked) => this.#operations.controlGeneration(checked)),
    );
  }
}

export type HostTargets = Readonly<{
  host: ConversationHostTarget;
  generations: GenerationHostTarget;
}>;

export function servingHosts(
  ports: HostPorts,
  generations: GenerationOperations,
  serves: () => boolean,
): HostTargets {
  return {
    host: new ConversationHostTarget({
      ...ports,
      arm: (wake) => whileServing(serves, () => ports.arm(wake)),
      running: (report) => whileServing(serves, () => ports.running(report)),
      workspace: (conversationId) => whileServing(serves, () => ports.workspace(conversationId)),
    }),
    generations: new GenerationHostTarget(generations, serves),
  };
}
