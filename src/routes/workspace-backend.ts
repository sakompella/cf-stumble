import * as Effect from "effect/Effect";
import { BackendChange } from "../api/answers.js";
import type { BackendSetting, WorkspaceBackendChange } from "../backend-setting.js";
import {
  answer,
  callSupervisor,
  decodeRequestBody,
  invalidRequestBody,
  refusal,
  type Handlers,
} from "./json.js";

export type WorkspaceBackendApiSupervisor = Readonly<{
  getWorkspaceBackend: () => Promise<BackendSetting>;
  setWorkspaceBackend: (setting: BackendSetting) => Promise<WorkspaceBackendChange>;
}>;

const changeResponse = Effect.fnUntraced(function* (
  request: Request,
  supervisor: WorkspaceBackendApiSupervisor,
) {
  const body = yield* decodeRequestBody(request, BackendChange);
  const change = yield* callSupervisor(() => supervisor.setWorkspaceBackend(body.backend));

  return change.ok ? answer("POST /api/workspace/backend", change) : refusal(change);
}, invalidRequestBody("invalid-backend-request"));

export const WORKSPACE_BACKEND_HANDLERS: Handlers<
  WorkspaceBackendApiSupervisor,
  "GET /api/workspace/backend" | "POST /api/workspace/backend"
> = {
  "GET /api/workspace/backend": (_request, supervisor) =>
    callSupervisor(() => supervisor.getWorkspaceBackend()).pipe(
      Effect.map((backend) => answer("GET /api/workspace/backend", { ok: true, backend })),
    ),
  "POST /api/workspace/backend": changeResponse,
};
