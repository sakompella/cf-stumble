import type { Wake } from "@earendil-works/pi-durable";
import type { ProjectRpcTargetContract } from "../workspace/project/protocol.js";

export interface ConversationHost {
  arm(wake: Wake): Promise<void>;
  running(conversationIds: readonly string[]): Promise<void>;
  workspace(conversationId: string): Promise<ProjectRpcTargetContract & Disposable>;
}

export interface ConversationFacet {
  compatibility(): string;
  attach(host: ConversationHost): Promise<void>;
  createConversation(cwd: string): Promise<string>;
  submit(conversationId: string, content: string, requestId: string): Promise<number>;
  events(conversationId: string): Promise<ReadableStream<Uint8Array>>;
  abort(conversationId: string): Promise<void>;
}
