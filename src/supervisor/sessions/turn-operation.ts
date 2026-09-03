import { parseFacetTurnResult } from "./session.js";
import type {
  FacetTurnResult,
  SessionTurnOptions,
  SessionTurnResponse,
  SessionTurnResult,
} from "./session.js";
import type { SessionStore } from "./index.js";

export type SessionFacetMount =
  | { readonly ok: true; readonly fetcher: Fetcher }
  | { readonly ok: false };

type FacetInvocation =
  | { readonly ok: true; readonly result: FacetTurnResult }
  | { readonly ok: false; readonly kind: "failed" | "malformed" | "timeout" };

export async function executeSessionTurn(
  sessions: SessionStore,
  mount: () => Promise<SessionFacetMount>,
  sessionId: string,
  prompt: string,
  expectedRevision: number,
  options: SessionTurnOptions,
  leaseMs: number,
  timeoutMs: number,
): Promise<SessionTurnResult> {
  const started = sessions.startTurnWithLease(
    sessionId,
    expectedRevision,
    options.now ?? Date.now(),
    leaseMs,
  );
  if (!started.ok) {
    return { ok: false, problem: started.problem };
  }

  const lease = started.lease;
  const release = (): void => {
    sessions.abandonTurnWithLease(sessionId, lease.leaseId);
  };
  const invocation = await runFacetTurn(mount, prompt, lease.session.document, timeoutMs);
  if (!invocation.ok) {
    release();
    return { ok: false, problem: { code: facetProblem(invocation.kind), sessionId } };
  }

  const finished = sessions.finishTurnWithLease(
    sessionId,
    expectedRevision,
    invocation.result.document,
    options.now ?? Date.now(),
    lease.leaseId,
  );
  if (!finished.ok) {
    release();
    return { ok: false, problem: finished.problem };
  }

  const response: SessionTurnResponse = {
    text: invocation.result.text,
    commands: invocation.result.commands,
    sessionRevision: finished.session.revision,
  };
  return { ok: true, response };
}

async function runFacetTurn(
  mount: () => Promise<SessionFacetMount>,
  prompt: string,
  document: string | undefined,
  timeoutMs: number,
): Promise<FacetInvocation> {
  try {
    const mounted = await mount();
    if (!mounted.ok) {
      return { ok: false, kind: "failed" };
    }
    return await invokeFacetTurn(mounted.fetcher, prompt, document, timeoutMs);
  } catch {
    return { ok: false, kind: "failed" };
  }
}

function facetProblem(
  kind: Extract<FacetInvocation, { readonly ok: false }>["kind"],
): "facet-failed" | "facet-timeout" | "malformed-facet-result" {
  return kind === "malformed"
    ? "malformed-facet-result"
    : kind === "timeout"
      ? "facet-timeout"
      : "facet-failed";
}

async function invokeFacetTurn(
  fetcher: Fetcher,
  prompt: string,
  document: string | undefined,
  timeoutMs: number,
): Promise<FacetInvocation> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const request = new Request("https://main-facet.invalid/turn", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt, document: document ?? null }),
    signal: controller.signal,
  });
  const operation = fetcher
    .fetch(request)
    .then(async (response): Promise<FacetInvocation> => {
      if (response.status >= 400) {
        return { ok: false, kind: "failed" };
      }
      let value: unknown;
      try {
        value = await response.json();
      } catch {
        return { ok: false, kind: "malformed" };
      }
      const parsed = parseFacetTurnResult(value);
      return parsed === undefined ? { ok: false, kind: "malformed" } : { ok: true, result: parsed };
    })
    .catch((): FacetInvocation => ({ ok: false, kind: "failed" }));
  const timeout = new Promise<FacetInvocation>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ ok: false, kind: "timeout" });
    }, timeoutMs);
  });

  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
