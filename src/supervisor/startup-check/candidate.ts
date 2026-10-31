import * as Result from "effect/Result";
import { loadMainFacet } from "../../facet/index.js";
import type {
  MainFacetCapabilities,
  MainFacetTarget,
  MainHarnessArtifactInput,
} from "../../facet/index.js";
import { PI_DURABLE_VERSION } from "../../pi-durable-version.js";
import { candidateFacetName } from "../artifacts/index.js";
import { deadlineAfter, drainResponseBody, errorReason } from "./body.js";
import type { Deadline, StartupCheckOutcome, ThrownValue } from "./body.js";
import type { StartupCheckHost } from "./index.js";

type StartupRequestBounds = Readonly<{
  deadlineMs: number;
  maxBodyBytes: number;
}>;

type CandidateMount =
  | Readonly<{ ok: true; fetcher: Fetcher<MainFacetTarget> }>
  | Readonly<{ ok: false; reason: string }>;

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

    const response = await classifyCandidateResponse(
      candidate.fetcher,
      deadline,
      bounds.maxBodyBytes,
    );

    return response.stage === "ready"
      ? await checkPiDurableVersion(candidate.fetcher, deadline, response)
      : response;
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

async function checkPiDurableVersion(
  facet: Fetcher<MainFacetTarget>,
  deadline: Deadline,
  ready: StartupCheckOutcome,
): Promise<StartupCheckOutcome> {
  const reported = await Promise.race([
    facet.piDurableVersion().then(
      (version) => ({ kind: "reported" as const, version }),
      () => ({ kind: "unreported" as const }),
    ),
    deadline.elapsed.then(() => ({ kind: "deadline" as const })),
  ]);

  if (reported.kind === "deadline") {
    return { stage: "deadline-expired", reason: "the Pi Durable version exceeded the deadline" };
  }

  if (reported.kind === "reported" && reported.version === PI_DURABLE_VERSION) return ready;

  return {
    stage: "version-mismatch",
    reason:
      reported.kind === "reported"
        ? `the generation runs Pi Durable ${reported.version}; this Supervisor stores ${PI_DURABLE_VERSION}`
        : "the generation reports no Pi Durable version",
  };
}

function mountCandidateFacet(
  host: StartupCheckHost,
  input: MainHarnessArtifactInput,
  harnessCommit: string,
  modelRoute: MainFacetCapabilities["MODEL"],
): CandidateMount {
  try {
    const loadedFacet = loadMainFacet(host.loader, input, { MODEL: modelRoute });

    if (Result.isFailure(loadedFacet)) {
      return { ok: false, reason: loadedFacet.failure.code };
    }

    const name = candidateFacetName(harnessCommit);
    host.ctx.facets.abort(name, "discard prior startup-check candidate");

    return {
      ok: true,
      fetcher: host.ctx.facets.get(name, () => ({ class: loadedFacet.success.facetClass })),
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
