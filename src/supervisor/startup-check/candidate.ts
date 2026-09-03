import { Result, TaggedError } from "better-result";
import { loadMainFacet } from "../../facet/index.js";
import type { MainFacetCapabilities, MainHarnessArtifactInput } from "../../facet/index.js";
import { mainFacetName } from "../artifacts/index.js";
import { deadlineAfter } from "./deadline.js";
import type { Deadline } from "./deadline.js";
import { drainResponseBody } from "./body.js";
import type { StartupCheckOutcome } from "./body.js";

type ThrownValue = Error | string | number | boolean | null | undefined;

function errorReason(error: ThrownValue): string {
  return error instanceof Error ? error.message : String(error);
}

export type StartupRequestBounds = Readonly<{
  deadlineMs: number;
  maxBodyBytes: number;
}>;

/**
 * ADR-0029: mount the module map as a candidate facet of the Supervisor's own and send it one
 * ordinary `GET /` under a deadline and a byte bound. This never touches the serving facet.
 */
export async function runStartupCheck(
  ctx: DurableObjectState,
  loader: WorkerLoader,
  input: MainHarnessArtifactInput,
  harnessCommit: string,
  modelRoute: MainFacetCapabilities["MODEL"],
  bounds: StartupRequestBounds,
): Promise<StartupCheckOutcome> {
  const deadline = deadlineAfter(bounds.deadlineMs);
  const maxBodyBytes = bounds.maxBodyBytes;

  try {
    const loadedFacet = mountCandidateFacet(ctx, loader, input, harnessCommit, modelRoute);
    if (loadedFacet.isErr()) {
      return loadedFacet.error.match({
        MainFacetMountFailed: (error): StartupCheckOutcome => ({
          stage: "mount-failed",
          reason: error.reason,
        }),
      });
    }

    return await classifyCandidateResponse(loadedFacet.value, deadline, maxBodyBytes);
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
  if (response.isErr()) {
    return response.error.match({
      StartupHeadersNotReceived: (error): StartupCheckOutcome => ({
        stage: "headers-not-received",
        reason: error.reason,
      }),
      StartupHeaderDeadlineExceeded: (error): StartupCheckOutcome => ({
        stage: "deadline-expired",
        reason: error.reason,
      }),
    });
  }

  if (response.value.status >= 400) {
    return {
      stage: "response-rejected",
      reason: `response status was ${response.value.status}`,
      status: response.value.status,
    };
  }

  return drainResponseBody(response.value, deadline, maxBodyBytes);
}

class MainFacetMountFailed extends TaggedError("MainFacetMountFailed")<{
  readonly reason: string;
  readonly message: string;
}> {}

class StartupHeadersNotReceived extends TaggedError("StartupHeadersNotReceived")<{
  readonly reason: string;
  readonly message: string;
}> {}

class StartupHeaderDeadlineExceeded extends TaggedError("StartupHeaderDeadlineExceeded")<{
  readonly reason: string;
  readonly message: string;
}> {}

type HeaderFailure = StartupHeadersNotReceived | StartupHeaderDeadlineExceeded;

function mountCandidateFacet(
  ctx: DurableObjectState,
  loader: WorkerLoader,
  input: MainHarnessArtifactInput,
  harnessCommit: string,
  modelRoute: MainFacetCapabilities["MODEL"],
): Result<Fetcher, MainFacetMountFailed> {
  try {
    const loadedFacet = loadMainFacet(loader, input, { MODEL: modelRoute });
    if (loadedFacet.isErr()) {
      const reason = loadedFacet.error.code;
      return Result.err(
        new MainFacetMountFailed({
          reason,
          message: `Candidate facet for ${harnessCommit} could not mount: ${reason}`,
        }),
      );
    }

    const name = mainFacetName(harnessCommit, "candidate");
    ctx.facets.abort(name, "discard prior startup-check candidate");
    return Result.ok(ctx.facets.get(name, () => ({ class: loadedFacet.value.facetClass })));
  } catch {
    const reason = "candidate facet could not mount";
    return Result.err(new MainFacetMountFailed({ reason, message: reason }));
  }
}

function responseBeforeDeadline(
  fetcher: Fetcher,
  deadline: Deadline,
): Promise<Result<Response, HeaderFailure>> {
  return Promise.race([
    fetcher.fetch(new Request("https://main-facet.invalid/")).then(
      (response) => Result.ok<Response, HeaderFailure>(response),
      (error: ThrownValue) => {
        const reason = errorReason(error);
        return Result.err<Response, HeaderFailure>(
          new StartupHeadersNotReceived({
            reason,
            message: `Startup-check response headers were not received: ${reason}`,
          }),
        );
      },
    ),
    deadline.elapsed.then(() => {
      const reason = "response headers exceeded the deadline";
      return Result.err<Response, HeaderFailure>(
        new StartupHeaderDeadlineExceeded({ reason, message: reason }),
      );
    }),
  ]);
}
