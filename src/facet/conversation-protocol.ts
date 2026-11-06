import type { Wake } from "@earendil-works/pi-durable";
import type { EntriesRequest } from "../entries-request.js";
import type { GenerationControl } from "../generation-requests.js";
import type { ProjectRpcTargetContract } from "../workspace/project/protocol.js";

export type { GenerationControl };

export type RunningConversation = Readonly<{ conversationId: string; run?: number | undefined }>;

export type FacetLogLevel = "info" | "error";

export type FacetLogFields = Readonly<Record<string, string | number | boolean | null>>;

export type FacetLog = (level: FacetLogLevel, event: string, fields: FacetLogFields) => void;

export interface ConversationHost {
  arm(wake: Wake): Promise<void>;
  log(level: FacetLogLevel, event: string, fields: FacetLogFields): Promise<void>;
  running(conversations: readonly RunningConversation[]): Promise<void>;
  workspace(conversationId: string): Promise<ProjectRpcTargetContract & Disposable>;
}

export interface ConversationFacet {
  compatibility(): string;
  attach(host: ConversationHost, generations?: GenerationControl): Promise<void>;
  createConversation(cwd: string): Promise<string>;
  submit(conversationId: string, content: string, requestId: string): Promise<number>;
  events(conversationId: string, from?: number): Promise<ReadableStream<Uint8Array>>;
  entries(conversationId: string, request: EntriesRequest): Promise<string>;
  abort(conversationId: string): Promise<void>;
}

export function hostLog(host: ConversationHost): FacetLog {
  return (level, event, fields) => {
    void host.log(level, event, fields).catch(() => {});
  };
}

export type ErrorFields = Readonly<{ cause: string; stack?: string }>;

export function errorFields(error: Error): ErrorFields {
  return {
    cause: `${error.message}; ${String(error.cause)}`,
    stack: (error.stack ?? "").split("\n").slice(1, 4).join(" | "),
  };
}
