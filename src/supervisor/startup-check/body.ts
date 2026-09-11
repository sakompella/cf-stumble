import type { Deadline } from "./deadline.js";

export type StartupCheckStage =
  | "ready"
  | "mount-failed"
  | "headers-not-received"
  | "response-rejected"
  | "body-failed"
  | "deadline-expired";

export type StartupCheckOutcome =
  | { readonly stage: "ready"; readonly reason: string; readonly status: number }
  | { readonly stage: "response-rejected"; readonly reason: string; readonly status: number }
  | {
      readonly stage: Exclude<StartupCheckStage, "ready" | "response-rejected">;
      readonly reason: string;
    };

type ThrownValue = Error | string | number | boolean | null | undefined;

function errorReason(error: ThrownValue): string {
  return error instanceof Error ? error.message : String(error);
}

export function drainResponseBody(
  response: Response,
  deadline: Deadline,
  maxBodyBytes: number,
): Promise<StartupCheckOutcome> {
  const declaredLength = responseLength(response);

  if (declaredLength !== undefined && declaredLength > maxBodyBytes) {
    return Promise.resolve({
      stage: "body-failed",
      reason: `response body declared ${declaredLength} bytes, exceeding the ${maxBodyBytes}-byte bound`,
    });
  }

  if (response.body === null) {
    return Promise.resolve({
      stage: "ready",
      reason: "response completed without a body",
      status: response.status,
    });
  }

  return drainBody(response.body.getReader(), response.status, deadline, maxBodyBytes);
}

async function drainBody(
  reader: ReadableStreamDefaultReader,
  responseStatus: number,
  deadline: Deadline,
  maxBodyBytes: number,
): Promise<StartupCheckOutcome> {
  let bodyBytes = 0;

  try {
    while (true) {
      const result = await Promise.race([
        reader.read().then(
          (chunk: ReadableStreamReadResult<Uint8Array>) => ({ kind: "chunk" as const, chunk }),
          (error: ThrownValue) => ({ kind: "failure" as const, error }),
        ),
        deadline.elapsed.then(() => ({ kind: "deadline" as const })),
      ]);

      if (result.kind === "deadline") {
        void reader.cancel("startup-check deadline expired");

        return { stage: "deadline-expired", reason: "response body exceeded the deadline" };
      }

      if (result.kind === "failure") {
        return { stage: "body-failed", reason: errorReason(result.error) };
      }

      if (result.chunk.done) {
        return {
          stage: "ready",
          reason: `response body completed in ${bodyBytes} bytes`,
          status: responseStatus,
        };
      }

      bodyBytes += result.chunk.value.byteLength;

      if (bodyBytes > maxBodyBytes) {
        void reader.cancel("startup-check body exceeded byte bound");

        return {
          stage: "body-failed",
          reason: `response body exceeded the ${maxBodyBytes}-byte bound`,
        };
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function responseLength(response: Response): number | undefined {
  const value = response.headers.get("content-length");

  if (value === null || !/^\d+$/u.test(value)) {
    return undefined;
  }

  return Number(value);
}
