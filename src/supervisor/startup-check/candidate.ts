import { loadMainFacet } from "../../facet/index.js";
import type { MainFacetCapabilities, MainHarnessArtifactInput } from "../../facet/index.js";
import { mainFacetName } from "../artifacts/index.js";
import { deadlineAfter, drainResponseBody, errorReason } from "./body.js";
import type { Deadline, StartupCheckOutcome, ThrownValue } from "./body.js";
import type { StartupCheckHost } from "./index.js";

export type StartupRequestBounds = Readonly<{
  deadlineMs: number;
  maxBodyBytes: number;
}>;

type CandidateMount =
  | Readonly<{ ok: true; fetcher: Fetcher }>
  | Readonly<{ ok: false; reason: string }>;

/**
 * ADR-0029: mount the module map as a candidate facet of the Supervisor's own and send it one
 * ordinary `GET /` under a deadline and a byte bound. This never touches the serving facet.
 */
export async function runStartupCheck(
  host: StartupCheckHost,
  input: MainHarnessArtifactInput,
  harnessCommit: string,
  bounds: StartupRequestBounds,
): Promise<StartupCheckOutcome> {
  const modelRoute = host.modelRoute();
  const deadline = deadlineAfter(bounds.deadlineMs);

  try {
    const candidate = mountCandidateFacet(host, input, harnessCommit, modelRoute);

    if (!candidate.ok) {
      return { stage: "mount-failed", reason: candidate.reason };
    }

    return await classifyCandidateResponse(candidate.fetcher, deadline, bounds.maxBodyBytes);
  } finally {
    deadline.cancel();
  }
}

async function classifyCandidateResponse(
  fetcher: Fetcher,
  deadline: Deadline,
  maxBodyBytes: number,
): Promise<StartupCheckOutcome> {
  const response = await responseBeforeDeadline(fetcher, deadline);

  if (!(response instanceof Response)) {
    return response;
  }

  if (response.status >= 400) {
    return {
      stage: "response-rejected",
      reason: `response status was ${response.status}`,
      status: response.status,
    };
  }

  return drainResponseBody(response, deadline, maxBodyBytes);
}

function mountCandidateFacet(
  host: StartupCheckHost,
  input: MainHarnessArtifactInput,
  harnessCommit: string,
  modelRoute: MainFacetCapabilities["MODEL"],
): CandidateMount {
  try {
    const loadedFacet = loadMainFacet(host.loader, input, { MODEL: modelRoute });

    if (loadedFacet.isErr()) {
      return { ok: false, reason: loadedFacet.error.code };
    }

    const name = mainFacetName(harnessCommit, "candidate");
    host.ctx.facets.abort(name, "discard prior startup-check candidate");

    return {
      ok: true,
      fetcher: host.ctx.facets.get(name, () => ({ class: loadedFacet.value.facetClass })),
    };
  } catch {
    return { ok: false, reason: "candidate facet could not mount" };
  }
}

function responseBeforeDeadline(
  fetcher: Fetcher,
  deadline: Deadline,
): Promise<Response | StartupCheckOutcome> {
  return Promise.race([
    fetcher
      .fetch(new Request("https://main-facet.invalid/"))
      .catch((error: ThrownValue): StartupCheckOutcome => ({
        stage: "headers-not-received",
        reason: errorReason(error),
      })),
    deadline.elapsed.then((): StartupCheckOutcome => ({
      stage: "deadline-expired",
      reason: "response headers exceeded the deadline",
    })),
  ]);
}
