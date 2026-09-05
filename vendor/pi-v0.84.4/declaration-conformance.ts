import type * as Exported from "@cf-stumble/pi";
import type * as Upstream from "@vendored-source/pi";

type IsAssignable<From, To> = [From] extends [To] ? true : false;
type Equivalent<Left, Right> = IsAssignable<Left, Right> extends true
  ? IsAssignable<Right, Left>
  : false;
type Assert<T extends true> = T;
type StreamFnShape<Stream> = Stream extends (...arguments_: infer Arguments) => infer Output
  ? {
      arguments: Arguments;
      result: Awaited<Output> extends AsyncIterable<infer Event> & { result(): Promise<infer Final> }
        ? { event: Event; final: Final }
        : never;
    }
  : never;
type AgentOptionsShape<Options> = Options extends { streamFn: infer Stream }
  ? { other: Omit<Options, "streamFn">; stream: StreamFnShape<Stream> }
  : never;
// AssistantMessageEventStream carries private fields, so two separately-compiled declaration
// emits of it are never nominally assignable to each other even when structurally identical.
// Compare the public async-iterable-plus-result shape instead, the same way StreamFnShape does
// for the class instances stream functions return.
type EventStreamShape<Stream> = Stream extends AsyncIterable<infer Event> & {
  result(): Promise<infer Final>;
}
  ? { event: Event; final: Final }
  : never;

export type ExportedTypesConformToVendoredPi = [
  Assert<Equivalent<AgentOptionsShape<Exported.AgentOptions>, AgentOptionsShape<Upstream.AgentOptions>>>,
  Assert<Equivalent<Exported.AgentEvent, Upstream.AgentEvent>>,
  Assert<Equivalent<Exported.AgentMessage, Upstream.AgentMessage>>,
  Assert<Equivalent<Exported.AgentState, Upstream.AgentState>>,
  Assert<Equivalent<Exported.AgentTool, Upstream.AgentTool>>,
  Assert<Equivalent<StreamFnShape<Exported.StreamFn>, StreamFnShape<Upstream.StreamFn>>>,
  Assert<Equivalent<Exported.BashExecutionMessage, Upstream.BashExecutionMessage>>,
  Assert<Equivalent<Exported.CustomMessage, Upstream.CustomMessage>>,
  Assert<Equivalent<Exported.BranchSummaryMessage, Upstream.BranchSummaryMessage>>,
  Assert<Equivalent<Exported.CompactionSummaryMessage, Upstream.CompactionSummaryMessage>>,
  Assert<Equivalent<typeof Exported.convertToLlm, typeof Upstream.convertToLlm>>,
  Assert<Equivalent<typeof Exported.createCompactionSummaryMessage, typeof Upstream.createCompactionSummaryMessage>>,
  Assert<Equivalent<Exported.CompactionPreparation, Upstream.CompactionPreparation>>,
  Assert<Equivalent<Exported.CompactionSettings, Upstream.CompactionSettings>>,
  Assert<Equivalent<Exported.CompactResult, Upstream.CompactResult>>,
  Assert<Equivalent<Exported.Entry, Upstream.Entry>>,
  Assert<Equivalent<Exported.MessageEntry, Upstream.MessageEntry>>,
  Assert<Equivalent<typeof Exported.DEFAULT_COMPACTION_SETTINGS, typeof Upstream.DEFAULT_COMPACTION_SETTINGS>>,
  Assert<Equivalent<typeof Exported.estimateContextTokens, typeof Upstream.estimateContextTokens>>,
  Assert<Equivalent<typeof Exported.prepareCompaction, typeof Upstream.prepareCompaction>>,
  Assert<Equivalent<typeof Exported.shouldCompact, typeof Upstream.shouldCompact>>,
  // Models and compact are exported but not asserted here. Models.stream returns
  // AssistantMessageEventStream, whose private fields make two separately-compiled declaration
  // emits nominally distinct, for exactly the reason EventStreamShape above records; compact takes
  // a Models parameter and inherits that. Comparing them yields false against an identical type.
  Assert<Equivalent<Exported.Api, Upstream.Api>>,
  Assert<Equivalent<Exported.Model<Exported.Api>, Upstream.Model<Upstream.Api>>>,
  Assert<Equivalent<Exported.ExecutionEnv, Upstream.ExecutionEnv>>,
  Assert<Equivalent<Exported.ExecutionError, Upstream.ExecutionError>>,
  Assert<Equivalent<typeof Exported.ExecutionError, typeof Upstream.ExecutionError>>,
  Assert<Equivalent<Exported.FileError, Upstream.FileError>>,
  Assert<Equivalent<typeof Exported.FileError, typeof Upstream.FileError>>,
  Assert<Equivalent<Exported.FileInfo, Upstream.FileInfo>>,
  Assert<Equivalent<Exported.FileSystem, Upstream.FileSystem>>,
  Assert<Equivalent<Exported.Result<unknown, unknown>, Upstream.Result<unknown, unknown>>>,
  Assert<Equivalent<Exported.Shell, Upstream.Shell>>,
  Assert<Equivalent<Exported.ShellExecOptions, Upstream.ShellExecOptions>>,
  Assert<Equivalent<Exported.ExecutionToolContext, Upstream.ExecutionToolContext>>,
  Assert<
    Equivalent<
      Exported.AgentHarnessTool<Exported.ExecutionToolContext>,
      Upstream.AgentHarnessTool<Upstream.ExecutionToolContext>
    >
  >,
  Assert<Equivalent<typeof Exported.createBashTool, typeof Upstream.createBashTool>>,
  Assert<Equivalent<typeof Exported.createEditTool, typeof Upstream.createEditTool>>,
  Assert<Equivalent<typeof Exported.createReadTool, typeof Upstream.createReadTool>>,
  Assert<Equivalent<typeof Exported.createWriteTool, typeof Upstream.createWriteTool>>,
  Assert<Equivalent<StreamFnShape<typeof Exported.streamSimple>, StreamFnShape<typeof Upstream.streamSimple>>>,
  Assert<Equivalent<Exported.AiGatewayBinding, Upstream.AiGatewayBinding>>,
  Assert<Equivalent<typeof Exported.createGatewayBindingFetch, typeof Upstream.createGatewayBindingFetch>>,
  Assert<Equivalent<Exported.AssistantMessage, Upstream.AssistantMessage>>,
  Assert<Equivalent<Exported.AssistantMessageEvent, Upstream.AssistantMessageEvent>>,
  Assert<Equivalent<Exported.ToolCall, Upstream.ToolCall>>,
  Assert<Equivalent<Exported.ToolResultMessage, Upstream.ToolResultMessage>>,
  Assert<
    Equivalent<
      EventStreamShape<Exported.AssistantMessageEventStream>,
      EventStreamShape<Upstream.AssistantMessageEventStream>
    >
  >,
  Assert<
    Equivalent<
      StreamFnShape<typeof Exported.createAssistantMessageEventStream>,
      StreamFnShape<typeof Upstream.createAssistantMessageEventStream>
    >
  >,
];
