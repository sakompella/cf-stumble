import type {
  BackendHandle,
  WorkspaceBackend,
  WorkspaceServiceProxyProps,
} from "@cloudflare/computer";
import type { ShellWorker } from "@cloudflare/computer/backends/worker-shell";
import * as Schema from "effect/Schema";
import { SHELL_MODULES_FILE, type ShellModuleSet } from "./shell-modules.js";

type ShellRpc = BackendHandle["rpc"]["shell"];

type ShellEvents = Awaited<ReturnType<ShellRpc["exec"]>>["events"];

type ShellEvent = ShellEvents extends ReadableStream<infer Event> ? Event : never;

export interface ShellHost {
  readonly id: DurableObjectId;
  readonly exports: {
    WorkspaceServiceProxy(options: { props: WorkspaceServiceProxyProps }): Fetcher;
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

function fetchModules(assets: Fetcher): () => Promise<ShellModuleSet> {
  let loaded: Promise<ShellModuleSet> | undefined;

  return () => {
    loaded ??= assets
      .fetch(`https://assets.invalid/${SHELL_MODULES_FILE}`)
      .then((response) => response.json<ShellModuleSet>());

    return loaded;
  };
}

function proxyProps(host: ShellHost): WorkspaceServiceProxyProps {
  const props: WorkspaceServiceProxyProps = { binding: "WORKSPACE_HOST", id: host.id.toString() };

  if (host.id.name !== undefined) props.name = host.id.name;

  return props;
}

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
  const modules = fetchModules(assets);

  const runtime = () =>
    loader
      .get(`isolate-shell:${host.id.toString()}`, async () => {
        const set = await modules();

        return {
          compatibilityDate: COMPATIBILITY_DATE,
          compatibilityFlags: ["nodejs_compat"],
          mainModule: set.mainModule,
          modules: set.modules,
          env: { HOST: host.exports.WorkspaceServiceProxy({ props: proxyProps(host) }) },
          globalOutbound: null,
        };
      })
      .getEntrypoint<ShellWorker>("ShellWorker");

  return {
    id: "worker-shell",
    type: "worker-shell",
    description: "A just-bash shell in a Dynamic Worker with no container and no network.",
    connect: () =>
      Promise.resolve({
        rpc: { sync: NO_SYNC, shell: shellRpc(runtime) },
        sync: "none",
        close: () => Promise.resolve(),
      }),
  };
}
