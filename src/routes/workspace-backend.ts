import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { BackendSetting, type WorkspaceBackendChange } from "../backend-setting.js";
import {
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

const ChangeBody = Schema.Struct({ backend: BackendSetting });

const changeResponse = Effect.fnUntraced(function* (
  request: Request,
  supervisor: WorkspaceBackendApiSupervisor,
) {
  const body = yield* decodeRequestBody(request, ChangeBody);
  const change = yield* callSupervisor(() => supervisor.setWorkspaceBackend(body.backend));

  return change.ok ? Response.json(change) : refusal(change);
}, invalidRequestBody("invalid-backend-request"));

export const WORKSPACE_BACKEND_HANDLERS: Handlers<
  WorkspaceBackendApiSupervisor,
  "GET /api/workspace/backend" | "POST /api/workspace/backend"
> = {
  "GET /api/workspace/backend": (_request, supervisor) =>
    callSupervisor(() => supervisor.getWorkspaceBackend()).pipe(
      Effect.map((backend) => Response.json({ ok: true, backend })),
    ),
  "POST /api/workspace/backend": changeResponse,
};
