import * as Option from "effect/Option";
import type { BackendSetting, ContainerOutcome } from "../../backend-setting.js";
import { ChangeBackend } from "./commands-backend.js";
import { clearError, withError, type Handlers } from "./update-shared.js";
import type { Model } from "./model.js";

const WHAT_HAPPENED: Readonly<Record<ContainerOutcome, string>> = {
  stopped: "stopped the container",
  "not-running": "no container was running",
  kept: "already selected, nothing changed",
};

const PLACE: Readonly<Record<BackendSetting, string>> = {
  provider: "the provider",
  cloudflare: "Cloudflare",
};

function changeWording(
  backend: BackendSetting,
  container: ContainerOutcome,
  startsOn: BackendSetting,
): string {
  const next =
    backend === startsOn
      ? `the next container starts on ${PLACE[startsOn]}`
      : `no provider is connected, so the next container starts on ${PLACE[startsOn]}`;

  return `${WHAT_HAPPENED[container]}; ${next}`;
}

export function backendHandlers(
  model: Model,
): Handlers<
  "ClickedBackend" | "SucceededBackend" | "ChangedBackend" | "RejectedBackend" | "FailedBackend"
> {
  return {
    ClickedBackend: ({ backend }) => ({
      model: { ...clearError(model), backendResult: "changing" },
      commands: [ChangeBackend({ backend })],
    }),
    SucceededBackend: ({ backend }) => ({
      model: { ...model, maybeBackend: Option.some(backend), backendResult: "" },
    }),
    ChangedBackend: ({ backend, container, startsOn }) => ({
      model: {
        ...model,
        maybeBackend: Option.some(backend),
        backendResult: changeWording(backend, container, startsOn),
      },
    }),
    RejectedBackend: ({ wording }) => ({ model: { ...model, backendResult: wording } }),
    FailedBackend: ({ detail }) => ({
      model: {
        ...withError(model, "the workspace request", detail),
        backendResult: "request failed",
      },
    }),
  };
}
