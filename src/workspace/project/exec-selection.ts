import { computerExecBackend, type ExecWorkspace } from "./computer-adapter.js";
import {
  CONTAINER_BACKEND_ID,
  ISOLATE_BACKEND_ID,
  type ContainerLifecycleState,
  type ExecBackend,
} from "./exec-backend.js";
import { isolateWithContainerFallback } from "./exec-fallback.js";
import { routedBackend } from "./exec-routing.js";

export function chosenExecBackend(
  workspace: ExecWorkspace,
  containerState: ContainerLifecycleState,
): ExecBackend {
  const container = computerExecBackend(workspace, CONTAINER_BACKEND_ID, containerState);
  const isolate = computerExecBackend(workspace, ISOLATE_BACKEND_ID, null);

  const isolateFirst = isolateWithContainerFallback(isolate, container);

  return {
    exec: (input) => {
      if (routedBackend(input.command, input.backend) !== "isolate") return container.exec(input);

      return (input.backend === undefined ? isolateFirst : isolate).exec(input);
    },
  };
}
