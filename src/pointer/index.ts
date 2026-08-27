import { assertNever } from "../git/types.js";
import type { Sha } from "../git/types.js";
import type {
  Attestation,
  PromotionRejection,
  PromotionResult,
  Verdict,
} from "../generation/types.js";
import type { PointerStore } from "../storage/types.js";

export type PointerManagerOptions = {
  readonly store: PointerStore;
  readonly corpusVersion: string;
  readonly gateVersion: string;
};

export class PointerManager {
  private readonly store: PointerStore;
  private readonly corpusVersion: string;
  private readonly gateVersion: string;

  constructor(options: PointerManagerOptions) {
    this.store = options.store;
    this.corpusVersion = options.corpusVersion;
    this.gateVersion = options.gateVersion;
  }

  async promote(candidate: Sha, attestation: Attestation): Promise<PromotionResult> {
    const liveNow = await this.store.readPointer();
    const rejection = verifyAttestation(
      candidate,
      attestation,
      liveNow,
      this.corpusVersion,
      this.gateVersion,
    );
    if (rejection !== undefined) {
      return { outcome: "rejected", reason: rejection };
    }

    return movePointer(this.store, candidate, liveNow);
  }

  rollback(target: Sha, expected: Sha | undefined): Promise<PromotionResult> {
    return movePointer(this.store, target, expected);
  }
}

async function movePointer(
  store: PointerStore,
  next: Sha,
  expected: Sha | undefined,
): Promise<PromotionResult> {
  const swapped = await store.setPointer(next, expected);
  if (!swapped) {
    return {
      outcome: "rejected",
      reason: {
        kind: "pointer-moved",
        expected,
        actual: await store.readPointer(),
      },
    };
  }
  return { outcome: "promoted", from: expected, to: next };
}

function verifyAttestation(
  candidate: Sha,
  attestation: Attestation,
  liveNow: Sha | undefined,
  corpusVersion: string,
  gateVersion: string,
): PromotionRejection | undefined {
  if (attestation.candidate !== candidate) {
    return {
      kind: "wrong-candidate",
      attested: attestation.candidate,
      requested: candidate,
    };
  }
  if (attestation.validatedAgainst !== liveNow) {
    return {
      kind: "stale-attestation",
      validatedAgainst: attestation.validatedAgainst,
      liveNow,
    };
  }
  if (attestation.corpusVersion !== corpusVersion) {
    return {
      kind: "corpus-changed",
      attested: attestation.corpusVersion,
      current: corpusVersion,
    };
  }
  if (attestation.gateVersion !== gateVersion) {
    return {
      kind: "gate-changed",
      attested: attestation.gateVersion,
      current: gateVersion,
    };
  }

  return verifyVerdict(attestation.verdict);
}

function verifyVerdict(verdict: Verdict): PromotionRejection | undefined {
  switch (verdict) {
    case "pass":
      return undefined;
    case "fail":
    case "inconclusive":
      return { kind: "not-passing", verdict };
    default:
      return assertNever(verdict, "attestation verdict");
  }
}
