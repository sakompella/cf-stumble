/// <reference types="@cloudflare/workers-types" />

import { WorkerEntrypoint } from "cloudflare:workers";
import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@cf-stumble/pi";
import { createFacetExecutionEnv } from "../../../src/facet/generation-0/execution-env.js";
import type { ProjectRpcTargetContract } from "../../../src/workspace/project/protocol.js";

/**
 * Plain, structured-clone-safe evidence of running Pi's real stock tools against a
 * `ProjectRpcTargetContract` received live, as an RPC method argument, inside this loaded Worker
 * Loader isolate. Every field here already crossed back out over RPC once by the time a caller
 * holds this value, so nothing in it can be a stub, a stream, or anything else that only makes
 * sense inside this isolate.
 */
export interface PlainToolEvidence {
  readonly write: { readonly text: string };
  readonly read: { readonly text: string };
  readonly edit: {
    readonly text: string;
    readonly diff: string;
    readonly patch: string;
    readonly firstChangedLine: number | undefined;
  };
  readonly rereadAfterEdit: { readonly text: string };
  readonly bash: { readonly text: string; readonly fullOutputPath: string | undefined };
  /**
   * Whether every raw frame of a `startExec` event stream, read directly (bypassing
   * `createFacetExecutionEnv`'s own decoding), arrived as a `Uint8Array` rather than a
   * structurally-cloned `ExecEvent` object. Proves the wire contract this loaded isolate actually
   * received bytes across the RPC hop, not a same-isolate object reference.
   */
  readonly rawExecFramesAreBytes: boolean;
}

/** The shape of one stock tool's returned content item this fixture cares about: plain text. */
type ToolContentItem = { readonly type: string; readonly text?: string };

function textOf(content: readonly ToolContentItem[]): string {
  const first = content[0];

  if (first === undefined || first.type !== "text" || first.text === undefined) {
    throw new Error("expected a text tool result, got none or a non-text content item");
  }

  return first.text;
}

/**
 * Reads `startExec`'s raw event stream directly — the one wire contract `ProjectRpcTargetContract`
 * exposes, `ReadableStream<Uint8Array>` — without going through `createFacetExecutionEnv`'s own
 * NDJSON decoding, so this can check what actually crossed the RPC hop rather than what the
 * adapter chose to make of it.
 */
async function probeRawExecFrames(
  target: ProjectRpcTargetContract,
  command = "probe",
): Promise<boolean> {
  const started = await target.startExec({ command });

  if (!started.ok) throw new Error(`${command} startExec failed: ${started.error.code}`);

  const reader = started.value.events.getReader();
  let allFramesAreBytes = true;

  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- Each physical read must be observed before the next is requested.
    const step = await reader.read();

    if (step.done) break;
    const frame: unknown = step.value;

    if (!(frame instanceof Uint8Array)) allFramesAreBytes = false;
  }

  return allFramesAreBytes;
}

type StockToolRun = Omit<PlainToolEvidence, "rawExecFramesAreBytes"> & {
  readonly checkpointFramesAreBytes: boolean;
};

/** Writes `notes.txt`, reads it back, then checkpoints before any caller sees the edit run. */
async function writeReadCheckpoint(
  env: ReturnType<typeof createFacetExecutionEnv>,
  projectTarget: ProjectRpcTargetContract,
) {
  const write = await createWriteTool().execute(
    "write-1",
    { path: "notes.txt", content: "hello world" },
    undefined,
    undefined,
    { env },
  );

  const read = await createReadTool().execute(
    "read-1",
    { path: "notes.txt" },
    undefined,
    undefined,
    { env },
  );

  const checkpointFramesAreBytes = await probeRawExecFrames(projectTarget, "checkpoint");

  return { write, read, checkpointFramesAreBytes };
}

/** Edits `notes.txt`, rereads it, then runs the bash tool's own exec call. */
async function editRereadBash(env: ReturnType<typeof createFacetExecutionEnv>) {
  const edit = await createEditTool().execute(
    "edit-1",
    { path: "notes.txt", edits: [{ oldText: "world", newText: "there" }] },
    undefined,
    undefined,
    { env },
  );

  const rereadAfterEdit = await createReadTool().execute(
    "read-2",
    { path: "notes.txt" },
    undefined,
    undefined,
    { env },
  );

  const bash = await createBashTool().execute(
    "bash-1",
    { command: "echo hi" },
    undefined,
    undefined,
    {
      env,
    },
  );

  return { edit, rereadAfterEdit, bash };
}

/**
 * Runs Pi's four stock tools against `createFacetExecutionEnv` built on the received target, with
 * a host-observable checkpoint between the write and the edit: the caller can only inspect the
 * host-side provider's bytes at a point where it has actually regained control, and this isolate
 * has no other way to yield that control back except through another exec round trip.
 */
async function runStockTools(projectTarget: ProjectRpcTargetContract): Promise<StockToolRun> {
  const env = createFacetExecutionEnv({ cwd: "/workspace", projectTarget });
  const { write, read, checkpointFramesAreBytes } = await writeReadCheckpoint(env, projectTarget);
  const { edit, rereadAfterEdit, bash } = await editRereadBash(env);

  if (edit.details === undefined) throw new Error("expected the edit tool to return details");

  return {
    write: { text: textOf(write.content) },
    read: { text: textOf(read.content) },
    edit: {
      text: textOf(edit.content),
      diff: edit.details.diff,
      patch: edit.details.patch,
      firstChangedLine: edit.details.firstChangedLine,
    },
    rereadAfterEdit: { text: textOf(rereadAfterEdit.content) },
    bash: { text: textOf(bash.content), fullOutputPath: bash.details?.fullOutputPath },
    checkpointFramesAreBytes,
  };
}

/**
 * Test-only Worker Loader entrypoint. `exercise` receives a live `ProjectRpcTargetContract` as an
 * RPC method argument: the only way Workers RPC can hand this loaded isolate a capability that
 * calls back into a target constructed in the caller's isolate, since a Worker Loader's `env`
 * only accepts structured-clone values and service-binding stubs, never a locally constructed
 * `RpcTarget`. Everything below this line runs the real, unmodified `@cf-stumble/pi` stock tools
 * against `createFacetExecutionEnv` built on that received target.
 */
export default class LoadedExecutionEnvEntry extends WorkerEntrypoint {
  async pauseThenCancelExec(projectTarget: ProjectRpcTargetContract): Promise<void> {
    const started = await projectTarget.startExec({ command: "paused" });

    if (!started.ok) throw new Error(`paused startExec failed: ${started.error.code}`);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 20);
    });
    await projectTarget.kill(started.value.operationId);
  }

  async exercise(projectTarget: ProjectRpcTargetContract): Promise<PlainToolEvidence> {
    const rawExecFramesAreBytes = await probeRawExecFrames(projectTarget);
    const { checkpointFramesAreBytes, ...evidence } = await runStockTools(projectTarget);

    return {
      ...evidence,
      rawExecFramesAreBytes: rawExecFramesAreBytes && checkpointFramesAreBytes,
    };
  }
}
