import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { BackendSetting, type WorkspaceBackendChange } from "../backend-setting.js";
import { callSupervisor, decodeRequestBody, jsonError, type SupervisorCallFailed } from "./json.js";

export type WorkspaceBackendApiSupervisor = Readonly<{
  getWorkspaceBackend: () => Promise<BackendSetting>;
  setWorkspaceBackend: (setting: BackendSetting) => Promise<WorkspaceBackendChange>;
}>;

const ChangeBody = Schema.Struct({ backend: BackendSetting });

const changeResponse = Effect.fnUntraced(
  function* (request: Request, supervisor: WorkspaceBackendApiSupervisor) {
    const body = yield* decodeRequestBody(request, ChangeBody);
    const change = yield* callSupervisor(() => supervisor.setWorkspaceBackend(body.backend));

    return Response.json(change, { status: change.ok ? 200 : 409 });
  },
  Effect.catchTag("InvalidRequestBody", () =>
    Effect.succeed(jsonError(400, "invalid-backend-request")),
  ),
);

export function routeWorkspaceBackendRequest(
  request: Request,
  supervisor: WorkspaceBackendApiSupervisor,
): Effect.Effect<Response, SupervisorCallFailed> | undefined {
  if (new URL(request.url).pathname !== "/api/workspace/backend") return undefined;

  if (request.method === "GET")
    return callSupervisor(() => supervisor.getWorkspaceBackend()).pipe(
      Effect.map((backend) => Response.json({ ok: true, backend })),
    );

  return request.method === "POST" ? changeResponse(request, supervisor) : undefined;
}
