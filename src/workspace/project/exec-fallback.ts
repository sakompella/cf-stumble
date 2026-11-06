import type {
  BackendExecEvent,
  ExecBackend,
  ExecBackendHandle,
  ExecBackendInput,
} from "./exec-backend.js";

const NOTHING_RAN_EXIT_CODES: ReadonlySet<number> = new Set([127, 129]);

export function isolateWithContainerFallback(
  isolate: ExecBackend,
  container: ExecBackend,
): ExecBackend {
  return {
    async exec(input: ExecBackendInput): Promise<ExecBackendHandle> {
      let current = await isolate.exec(input);
      let held: BackendExecEvent[] = [];
      let ready: BackendExecEvent[] = [];
      let holding = true;
      let fellBack = false;

      const read: ExecBackendHandle["reader"]["read"] = async () => {
        for (;;) {
          const next = ready.shift();

          if (next !== undefined) return { done: false, value: next };

          if (!holding) return current.reader.read();

          const result = await current.reader.read();

          if (result.done) {
            holding = false;
          } else if (result.value.name === "stderr") {
            held.push(result.value);
          } else if (
            result.value.name === "exit" &&
            NOTHING_RAN_EXIT_CODES.has(result.value.exitCode)
          ) {
            holding = false;
            held = [];
            fellBack = true;
            current = await container.exec({ ...input, backend: "container" });
          } else {
            holding = false;
            ready = [...held, result.value];
            held = [];
          }
        }
      };

      return {
        reader: { read, cancel: () => current.reader.cancel() },
        kill: () => current.kill(),
        get fellBackFrom() {
          return fellBack ? "isolate" : undefined;
        },
      };
    },
  };
}
