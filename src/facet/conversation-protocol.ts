import type { Wake } from "@earendil-works/pi-durable";
import type { EntriesRequest } from "../entries-request.js";
import type { GenerationControl } from "../generation-requests.js";
import type { ProjectRpcTargetContract } from "../workspace/project/protocol.js";

export type { GenerationControl };

export type RunningConversation = Readonly<{ conversationId: string; run?: number | undefined }>;

export interface ConversationHost {
  arm(wake: Wake): Promise<void>;
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
