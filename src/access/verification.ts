// JWT parsing is the trust boundary. These checks intentionally validate unknown token data.
// oxlint-disable anti-slop/no-unknown-returns
import * as Arr from "effect/Array";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import * as SchemaTransformation from "effect/SchemaTransformation";
import type { AccessPublicKey } from "./keys.js";

/** The only token field used to route an authenticated request. */
export type AccessIdentity = string;

/**
 * Who a verified token speaks for. Access signs a person's token with their stable id in `sub`. It
 * signs a service token's with an empty `sub` and the token's Client ID in `common_name`.
 */
export type AccessPrincipal =
  | { readonly kind: "user"; readonly subject: AccessIdentity }
  | { readonly kind: "service-token"; readonly clientId: string };

export type AccessVerificationReason =
  | "malformed-token"
  | "unsupported-algorithm"
  | "invalid-signature"
  | "wrong-issuer"
  | "wrong-audience"
  | "invalid-expiry"
  | "expired"
  | "not-yet-valid"
  | "missing-identity";

/** The presented token proves no identity, for `reason`. */
export class TokenRejected extends Data.TaggedError("TokenRejected")<{
  readonly reason: AccessVerificationReason;
}> {}

export interface VerifyAccessTokenInput {
  readonly token: string;
  readonly issuer: string;
  readonly audience: string;
  readonly publicKeys: readonly AccessPublicKey[];
  /** Current Unix time in seconds. JWT `exp` and `nbf` use the same unit. */
  readonly now: number;
}

const JwtHeaderSchema = Schema.Struct({
  alg: Schema.Literals(["RS256", "ES256"]),
  kid: Schema.optionalKey(Schema.String),
});

type JwtHeader = typeof JwtHeaderSchema.Type;

const decodeHeader = Schema.decodeUnknownOption(JwtHeaderSchema);

/** A header that names an algorithm, even one this verifier refuses. */
const namesAlgorithm = Schema.is(Schema.Struct({ alg: Schema.String }));

/**
 * The claims checked before their values are compared. A struct decode stops at its first failing
 * key, in the order the fields are declared here, which is the order the refusals below take.
 */
const JwtClaims = Schema.Struct({
  iss: Schema.String,
  aud: Schema.Union([Schema.String, Schema.Array(Schema.String)]),
  exp: Schema.Finite,
  nbf: Schema.optionalKey(Schema.Finite),
});

const claimRefusals = {
  iss: "wrong-issuer",
  aud: "wrong-audience",
  exp: "invalid-expiry",
  nbf: "not-yet-valid",
} as const satisfies Record<keyof typeof JwtClaims.fields, AccessVerificationReason>;

function isRefusedClaim(key: unknown): key is keyof typeof claimRefusals {
  return typeof key === "string" && Object.hasOwn(claimRefusals, key);
}

const standardIssues = SchemaIssue.makeFormatterStandardSchemaV1();

// A claims value that is not an object fails at the root and has no `iss`, so it is a wrong issuer.
function claimRefusal(issue: SchemaIssue.Issue): AccessVerificationReason {
  const key = standardIssues(issue).issues[0]?.path?.[0];

  return isRefusedClaim(key) ? claimRefusals[key] : "wrong-issuer";
}

const decodeClaims = Schema.decodeUnknownEffect(JwtClaims);

const UserPrincipal = Schema.Struct({ kind: Schema.Literal("user"), subject: Schema.String });

const ServiceTokenPrincipal = Schema.Struct({
  kind: Schema.Literal("service-token"),
  clientId: Schema.String,
});

/** A non-empty `sub` is a person. An absent or empty one with a `common_name` is a service token. */
const PrincipalFromClaims = Schema.Union([
  Schema.Struct({ sub: Schema.NonEmptyString }).pipe(
    Schema.decodeTo(
      UserPrincipal,
      SchemaTransformation.transform({
        decode: ({ sub }) => ({ kind: "user" as const, subject: sub }),
        encode: ({ subject }) => ({ sub: subject }),
      }),
    ),
  ),
  Schema.Struct({
    sub: Schema.optionalKey(Schema.Literal("")),
    common_name: Schema.NonEmptyString,
  }).pipe(
    Schema.decodeTo(
      ServiceTokenPrincipal,
      SchemaTransformation.transform({
        decode: ({ common_name: clientId }) => ({ kind: "service-token" as const, clientId }),
        encode: ({ clientId }) => ({ common_name: clientId }),
      }),
    ),
  ),
]);

const decodePrincipal = Schema.decodeUnknownEffect(PrincipalFromClaims);

function rejected(reason: AccessVerificationReason): TokenRejected {
  return new TokenRejected({ reason });
}

function decodePart(part: string): Uint8Array | undefined {
  if (part.length === 0 || !/^[A-Za-z0-9_-]+$/u.test(part) || part.length % 4 === 1) {
    return undefined;
  }

  const base64 = part.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");

  try {
    const decoded = atob(padded);

    return Uint8Array.from(decoded, (character) => character.codePointAt(0) ?? 0);
  } catch {
    return undefined;
  }
}

function decodeJson(part: string): unknown {
  const bytes = decodePart(part);

  if (bytes === undefined) {
    return undefined;
  }

  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    return undefined;
  }
}

function keyMatches(key: AccessPublicKey, header: JwtHeader): boolean {
  if (key.kid !== undefined && key.kid !== header.kid) {
    return false;
  }

  if (key.alg !== undefined && key.alg !== header.alg) {
    return false;
  }

  if (key.use !== undefined && key.use !== "sig") {
    return false;
  }

  return header.alg === "RS256" ? key.kty === "RSA" : key.kty === "EC" && key.crv === "P-256";
}

function verificationAlgorithms(header: JwtHeader): {
  readonly importAs: SubtleCryptoImportKeyAlgorithm;
  readonly verifyAs: SubtleCryptoSignAlgorithm;
} {
  return header.alg === "RS256"
    ? {
        importAs: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        verifyAs: { name: "RSASSA-PKCS1-v1_5" },
      }
    : {
        importAs: { name: "ECDSA", namedCurve: "P-256" },
        verifyAs: { name: "ECDSA", hash: "SHA-256" },
      };
}

function verifiesKey(
  token: ParsedAccessToken,
  publicKey: AccessPublicKey,
  webCrypto: Crypto,
): Effect.Effect<boolean> {
  const { importAs, verifyAs } = verificationAlgorithms(token.header);

  return Effect.tryPromise(async () => {
    const key = await webCrypto.subtle.importKey("jwk", publicKey, importAs, false, ["verify"]);

    return webCrypto.subtle.verify(
      verifyAs,
      key,
      token.signature,
      new TextEncoder().encode(token.signingInput),
    );
  }).pipe(
    // A malformed configured key is indistinguishable from a failed signature at this boundary.
    Effect.orElseSucceed(() => false),
  );
}

const verifiesSignature = Effect.fnUntraced(function* (
  token: ParsedAccessToken,
  publicKeys: readonly AccessPublicKey[],
  webCrypto: Crypto,
) {
  for (const publicKey of publicKeys) {
    if (keyMatches(publicKey, token.header) && (yield* verifiesKey(token, publicKey, webCrypto))) {
      return true;
    }
  }

  return false;
});

export type ParsedAccessToken = {
  readonly header: JwtHeader;
  readonly claimsPart: string;
  readonly signature: Uint8Array;
  readonly signingInput: string;
};

/** Split and decode a token's header and signature. Nothing here is trusted yet. */
export const parseAccessToken = Effect.fnUntraced(function* (token: string) {
  const parts = token.split(".");
  const [encodedHeader, claimsPart, encodedSignature] = parts;

  if (
    parts.length !== 3 ||
    encodedHeader === undefined ||
    claimsPart === undefined ||
    encodedSignature === undefined ||
    parts.some((part) => part.length === 0)
  ) {
    return yield* rejected("malformed-token");
  }

  const decodedHeader = decodeJson(encodedHeader);
  const header = Option.getOrUndefined(decodeHeader(decodedHeader));

  if (header === undefined) {
    return yield* rejected(
      namesAlgorithm(decodedHeader) ? "unsupported-algorithm" : "malformed-token",
    );
  }

  const signature = decodePart(encodedSignature);

  if (signature === undefined) {
    return yield* rejected("malformed-token");
  }

  const parsed: ParsedAccessToken = {
    header,
    claimsPart,
    signature,
    signingInput: `${encodedHeader}.${claimsPart}`,
  };

  return parsed;
});

/**
 * Check the signature with `input.publicKeys`, then the claims, of a token that already parsed.
 * Claims are read only after the signature holds, so an unsigned claim cannot choose a refusal.
 */
export const verifyParsedAccessToken = Effect.fnUntraced(function* (
  token: ParsedAccessToken,
  input: Omit<VerifyAccessTokenInput, "token">,
  webCrypto: Crypto,
) {
  if (!(yield* verifiesSignature(token, input.publicKeys, webCrypto))) {
    return yield* rejected("invalid-signature");
  }

  const payload = decodeJson(token.claimsPart);

  const claims = yield* decodeClaims(payload).pipe(
    Effect.mapError((error) => rejected(claimRefusal(error.issue))),
  );

  const principal: AccessPrincipal = yield* decodePrincipal(payload).pipe(
    Effect.mapError(() => rejected("missing-identity")),
  );

  if (claims.iss !== input.issuer) {
    return yield* rejected("wrong-issuer");
  }

  if (!Arr.ensure(claims.aud).includes(input.audience)) {
    return yield* rejected("wrong-audience");
  }

  if (input.now >= claims.exp) {
    return yield* rejected("expired");
  }

  if (claims.nbf !== undefined && input.now < claims.nbf) {
    return yield* rejected("not-yet-valid");
  }

  return principal;
});

/** The principal a token proves against `input.publicKeys`, or why it proves none. */
export function verifyAccessToken(
  input: VerifyAccessTokenInput,
  webCrypto: Crypto = crypto,
): Effect.Effect<AccessPrincipal, TokenRejected> {
  return parseAccessToken(input.token).pipe(
    Effect.flatMap((token) => verifyParsedAccessToken(token, input, webCrypto)),
  );
}

interface DeriveSupervisorNameInput {
  readonly identity: AccessIdentity;
  readonly audience: string;
}

export function deriveSupervisorName(
  input: DeriveSupervisorNameInput,
  webCrypto: Crypto = crypto,
): Effect.Effect<string> {
  const value = new TextEncoder().encode(`${input.identity}\u0000${input.audience}`);

  return Effect.promise(() => webCrypto.subtle.digest("SHA-256", value)).pipe(
    Effect.map((digest) => {
      const bytes = new Uint8Array(digest);
      const hash = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

      return `access:${hash}`;
    }),
  );
}
