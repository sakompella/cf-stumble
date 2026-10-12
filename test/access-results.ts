/**
 * The Access programs run to the plain values the tests compare. The Worker answers a refusal from
 * its `reason`, so a refused result keeps only that code, exactly what a caller can observe.
 */
import * as Effect from "effect/Effect";
import {
  admitAccessRequest,
  deriveSupervisorName,
  verifyAccessToken,
  type AccessPrincipal,
  type AccessRefusalReason,
  type AccessVerificationReason,
  type AccessWorkerEnvironment,
  type AdmittedAccess,
  type VerifyAccessTokenInput,
} from "../src/access/index.js";

export type AccessResult =
  | ({ readonly ok: true } & AdmittedAccess)
  | { readonly ok: false; readonly reason: AccessRefusalReason };

export type VerificationResult =
  | { readonly ok: true; readonly principal: AccessPrincipal }
  | { readonly ok: false; readonly reason: AccessVerificationReason };

export function accessResult(
  request: Request,
  env: AccessWorkerEnvironment,
  now?: number,
  webCrypto?: Crypto,
  fetcher?: typeof fetch,
): Promise<AccessResult> {
  return Effect.runPromise(
    admitAccessRequest(request, env, now, webCrypto, fetcher).pipe(
      Effect.match({
        onSuccess: (admitted): AccessResult => ({ ok: true, ...admitted }),
        onFailure: (refusal): AccessResult => ({ ok: false, reason: refusal.reason }),
      }),
    ),
  );
}

export function verificationResult(
  input: VerifyAccessTokenInput,
  webCrypto?: Crypto,
): Promise<VerificationResult> {
  return Effect.runPromise(
    verifyAccessToken(input, webCrypto).pipe(
      Effect.match({
        onSuccess: (principal): VerificationResult => ({ ok: true, principal }),
        onFailure: (rejection): VerificationResult => ({ ok: false, reason: rejection.reason }),
      }),
    ),
  );
}

export function supervisorNameFor(
  input: Readonly<{ identity: string; audience: string }>,
): Promise<string> {
  return Effect.runPromise(deriveSupervisorName(input));
}
