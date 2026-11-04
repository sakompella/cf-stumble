import * as Option from "effect/Option";
import { ChangeBackend, FetchBackend } from "./commands-backend.js";
import { clearError, withError, type Handlers } from "./update-shared.js";
import type { Model } from "./model.js";

export { FetchBackend };

export function backendHandlers(
  model: Model,
): Handlers<"ClickedBackend" | "SucceededBackend" | "RejectedBackend" | "FailedBackend"> {
  return {
    ClickedBackend: ({ backend }) => ({
      model: { ...clearError(model), backendResult: "changing" },
      commands: [ChangeBackend({ backend })],
    }),
    SucceededBackend: ({ backend }) => ({
      model: { ...model, maybeBackend: Option.some(backend), backendResult: "" },
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
