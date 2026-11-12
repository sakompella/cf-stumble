import { computerExecBackend, type ExecWorkspace } from "./computer-adapter.js";
import {
  CONTAINER_BACKEND_ID,
  ISOLATE_BACKEND_ID,
  type BackendExecEvent,
  type ContainerLifecycleState,
  type ExecBackend,
  type ExecBackendHandle,
} from "./exec-backend.js";
import { isolateWithContainerFallback } from "./exec-fallback.js";
import { routedBackend } from "./exec-routing.js";

const ISOLATE_GIT_REFUSAL =
  'git runs only in the container. Leave out backend, or pass backend: "container".\n';

function refusedInIsolate(): ExecBackendHandle {
  const events = new ReadableStream<BackendExecEvent>({
    start(controller) {
      controller.enqueue({ name: "stderr", data: new TextEncoder().encode(ISOLATE_GIT_REFUSAL) });
      controller.enqueue({ name: "exit", exitCode: 1 });
      controller.close();
    },
  });

  return {
    reader: events.getReader(),
    kill: () => Promise.resolve(),
    backend: "isolate",
    isolateRefused: true,
  };
}

export function chosenExecBackend(
  workspace: ExecWorkspace,
  containerState: ContainerLifecycleState,
): ExecBackend {
  const container = computerExecBackend(workspace, CONTAINER_BACKEND_ID, containerState);
  const isolate = computerExecBackend(workspace, ISOLATE_BACKEND_ID, null);

  const isolateFirst = isolateWithContainerFallback(isolate, container);

  return {
    exec: (input) => {
      const route = routedBackend(input.command, input.backend);

      if (route === "refused") return Promise.resolve(refusedInIsolate());

      if (route === "container") return container.exec(input);

      return (input.backend === undefined ? isolateFirst : isolate).exec(input);
    },
  };
}
