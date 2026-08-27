import {
  DEFAULT_MODEL_REQUEST_ID,
  RecordedModelResponseSource,
  SYSTEM_PROMPT_PATH,
  type AgentDefinition,
  type ModelResponseSource,
} from "../agent/runtime/index.js";
import { assertNever } from "../git/types.js";
import type { PrimitiveCall } from "../tools/index.js";
import { InMemoryWorkspace } from "../tools/index.js";
import type { Workspace } from "../tools/index.js";
import type { PreflightProbe } from "./preflight.js";

export const probes: readonly PreflightProbe[] = [
  { capability: "read", path: "preflight/read.txt", content: "readable by preflight\n" },
  { capability: "write", path: "preflight/write.txt", content: "written by preflight\n" },
  {
    capability: "edit",
    path: "preflight/edit.txt",
    initialContent: "before\n",
    oldText: "before",
    newText: "after",
  },
  { capability: "bash", command: "printf 'preflight\\n'" },
  { capability: "self-edit", path: SYSTEM_PROMPT_PATH, suffix: "\nself-edited by preflight\n" },
];

export function defaultWorkspace(probe: PreflightProbe, definition: AgentDefinition): Workspace {
  switch (probe.capability) {
    case "read":
      return new InMemoryWorkspace({
        files: [{ path: probe.path, content: probe.content }],
      });
    case "write":
      return new InMemoryWorkspace();
    case "edit":
      return new InMemoryWorkspace({
        files: [{ path: probe.path, content: probe.initialContent }],
      });
    case "bash":
      return new InMemoryWorkspace({
        executeCommand: (command) => ({
          status: "completed",
          exitCode: command === probe.command ? 0 : 1,
          stdout: "preflight\n",
          stderr: "",
        }),
      });
    case "self-edit":
      return new InMemoryWorkspace({
        files: [{ path: probe.path, content: definition.systemPrompt }],
      });
    default:
      return assertNever(probe, "preflight probe");
  }
}

export function defaultResponseSource(
  probe: PreflightProbe,
  definition: AgentDefinition,
): ModelResponseSource {
  const call = callForProbe(probe, definition);
  return new RecordedModelResponseSource([
    {
      requestId: DEFAULT_MODEL_REQUEST_ID,
      content: JSON.stringify({
        type: "tool_call",
        name: call.kind,
        arguments: argumentsForCall(call),
      }),
    },
    {
      requestId: DEFAULT_MODEL_REQUEST_ID,
      content: JSON.stringify({ type: "final", content: "preflight complete" }),
    },
  ]);
}

export function callForProbe(probe: PreflightProbe, definition: AgentDefinition): PrimitiveCall {
  switch (probe.capability) {
    case "read":
      return { kind: "read", path: probe.path };
    case "write":
      return { kind: "write", path: probe.path, content: probe.content };
    case "edit":
      return {
        kind: "edit",
        path: probe.path,
        oldText: probe.oldText,
        newText: probe.newText,
      };
    case "bash":
      return { kind: "bash", command: probe.command };
    case "self-edit":
      return {
        kind: "edit",
        path: probe.path,
        oldText: definition.systemPrompt,
        newText: `${definition.systemPrompt}${probe.suffix}`,
      };
    default:
      return assertNever(probe, "preflight probe call");
  }
}

type ScriptedArguments =
  | { readonly path: string }
  | { readonly path: string; readonly content: string }
  | { readonly path: string; readonly oldText: string; readonly newText: string }
  | { readonly command: string };

function argumentsForCall(call: PrimitiveCall): ScriptedArguments {
  switch (call.kind) {
    case "read":
      return { path: call.path };
    case "write":
      return { path: call.path, content: call.content };
    case "edit":
      return { path: call.path, oldText: call.oldText, newText: call.newText };
    case "bash":
      return { command: call.command };
    default:
      return assertNever(call, "preflight primitive call");
  }
}
