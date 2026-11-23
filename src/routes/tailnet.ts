import type { TailnetStatus } from "../tailnet-status.js";
import type * as Effect from "effect/Effect";
import { answeringInternalErrors, callSupervisor } from "./json.js";

type Admin = Readonly<{
  status: () => Promise<TailnetStatus>;
  logout: () => Promise<void>;
}>;

export function routeTailnetRequest(
  request: Request,
  admin: Admin | undefined,
): Effect.Effect<Response> | undefined {
  const path = new URL(request.url).pathname;

  if (request.method === "GET" && path === "/api/tailnet/status") {
    return callSupervisor(async () => {
      if (admin === undefined) throw new Error("tailnet is not configured");

      return Response.json(await admin.status());
    }).pipe(answeringInternalErrors(request));
  }

  if (request.method === "POST" && path === "/api/tailnet/logout") {
    return callSupervisor(async () => {
      if (admin === undefined) throw new Error("tailnet is not configured");

      await admin.logout();

      return Response.json({ ok: true });
    }).pipe(answeringInternalErrors(request));
  }

  return undefined;
}
