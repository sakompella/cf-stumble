import type { Wake } from "@earendil-works/pi-durable";
import type { GenerationStatusView } from "../generation-requests.js";
import type { GenerationControlResult, Submission } from "../supervisor/generations.js";
import type { StartupCheckResult } from "../supervisor/startup-check/index.js";
import type { ProjectRpcTargetContract } from "../workspace/project/protocol.js";

type GenerationControlCommand = Readonly<{
  kind: "activate" | "rollback";
  label: number;
  observedEpoch: number;
}>;

export interface GenerationHost {
  generationStatus(): Promise<GenerationStatusView>;
  submitGeneration(harnessCommit: string): Promise<Submission>;
  prepareGeneration(label: number): Promise<StartupCheckResult>;
  controlGeneration(command: GenerationControlCommand): Promise<GenerationControlResult>;
}

export interface ConversationHost {
  arm(wake: Wake): Promise<void>;
  running(conversationIds: readonly string[]): Promise<void>;
  workspace(conversationId: string): Promise<ProjectRpcTargetContract & Disposable>;
}

export interface ConversationFacet {
  compatibility(): string;
  attach(host: ConversationHost, generations?: GenerationHost): Promise<void>;
  createConversation(cwd: string): Promise<string>;
  submit(conversationId: string, content: string, requestId: string): Promise<number>;
  events(conversationId: string): Promise<ReadableStream<Uint8Array>>;
  abort(conversationId: string): Promise<void>;
}
