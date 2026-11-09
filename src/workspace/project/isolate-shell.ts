import type { BackendHandle, WorkspaceBackend } from "@cloudflare/computer";
import type { ShellWorker } from "@cloudflare/computer/backends/worker-shell";
import * as Schema from "effect/Schema";
import { SHELL_MODULES_FILE } from "../../../infra/worker-settings.js";
import { ISOLATE_BACKEND_ID } from "./exec-backend.js";
import type { IsolateGateProps } from "./isolate-gate.js";

type ShellModuleSet = Readonly<{
  mainModule: string;
  modules: Record<string, { js?: string; cjs?: string; text?: string }>;
}>;

type ShellRpc = BackendHandle["rpc"]["shell"];

type ShellEvents = Awaited<ReturnType<ShellRpc["exec"]>>["events"];

type ShellEvent = ShellEvents extends ReadableStream<infer Event> ? Event : never;

export interface ShellHost {
  readonly id: DurableObjectId;
  readonly isolateToken: string;
  readonly exports: {
    IsolateWorkspaceGate(options: { props: IsolateGateProps }): Fetcher;
    IsolateEgressGateway(options: { props: Readonly<Record<string, never>> }): Fetcher;
  };
}

const COMPATIBILITY_DATE = "2026-06-17";

const Frame = Schema.Struct({
  id: Schema.String,
  seq: Schema.Number,
  name: Schema.Literals(["stdout", "stderr", "exit"]),
  value: Schema.Union([Schema.String, Schema.Number]),
});

const decodeFrame = Schema.decodeUnknownSync(Schema.fromJsonString(Frame));

function frameEvent(line: string): ShellEvent {
  const { id, seq, name, value } = decodeFrame(line);

  if (name === "exit") return { id, seq, name, code: Number(value) };

  return { id, seq, name, value: new TextEncoder().encode(String(value)) };
}

function framesToEvents(source: ReadableStream<Uint8Array>): ShellEvents {
  const decoder = new TextDecoder();
  let pending = "";

  return source.pipeThrough(
    new TransformStream<Uint8Array, ShellEvent>({
      transform(chunk, controller) {
        const lines = (pending + decoder.decode(chunk, { stream: true })).split("\n");
        pending = lines.pop() ?? "";

        for (const line of lines.filter((candidate) => candidate !== "")) {
          controller.enqueue(frameEvent(line));
        }
      },
      flush(controller) {
        if (pending !== "") controller.enqueue(frameEvent(pending));
      },
    }),
  );
}

function refuseSync(): never {
  throw new Error("the shell backend has no sync");
}

const NO_SYNC: BackendHandle["rpc"]["sync"] = {
  push: refuseSync,
  fetchChanges: refuseSync,
  readEntry: refuseSync,
  hasObjects: refuseSync,
  fetchObjects: refuseSync,
  pushObjects: refuseSync,
  watermarks: refuseSync,
};

function shellRpc(runtime: () => Fetcher<ShellWorker>): ShellRpc {
  return {
    async exec({ source, ...rest }) {
      const started = await runtime().exec({ command: source, ...rest });

      return { id: started.id, events: framesToEvents(started.events) };
    },
    getExec: () => Promise.reject(new Error("the shell backend keeps no past executions")),
    killExec: (input) => runtime().killExec(input),
    disposeExec: () => Promise.resolve(),
  };
}

export function isolateShellBackend(
  loader: WorkerLoader,
  assets: Fetcher,
  host: ShellHost,
): WorkspaceBackend {
  const runtime = () =>
    loader
      .get(`isolate-shell:${host.id.toString()}:${host.isolateToken}`, async () => {
        const response = await assets.fetch(`https://assets.invalid/${SHELL_MODULES_FILE}`);
        const set = await response.json<ShellModuleSet>();

        return {
          compatibilityDate: COMPATIBILITY_DATE,
          compatibilityFlags: ["nodejs_compat"],
          mainModule: set.mainModule,
          modules: set.modules,
          env: {
            HOST: host.exports.IsolateWorkspaceGate({
              props: { id: host.id.toString(), token: host.isolateToken },
            }),
            EGRESS: host.exports.IsolateEgressGateway({ props: {} }),
          },
          globalOutbound: null,
        };
      })
      .getEntrypoint<ShellWorker>("ShellWorker");

  return {
    id: ISOLATE_BACKEND_ID,
    type: "worker-shell",
    description:
      "A just-bash shell in a Dynamic Worker with no container, Git over the workspace, and curl through an egress gateway that allows only GET and HEAD to a fixed list of hosts.",
    connect: () =>
      Promise.resolve({
        rpc: { sync: NO_SYNC, shell: shellRpc(runtime) },
        sync: "none",
        close: () => Promise.resolve(),
      }),
  };
}
