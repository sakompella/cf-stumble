import type { PinnedCanary, ValidationCase } from "./results.js";
import { computeCorpusVersion } from "./versions.js";

export function validateCorpus(corpus: readonly ValidationCase[]): void {
  const names = new Set<string>();
  for (const validationCase of corpus) {
    if (validationCase.name.length === 0) {
      throw new TypeError("validation case name must not be empty");
    }
    if (names.has(validationCase.name)) {
      throw new TypeError(`duplicate validation case ${JSON.stringify(validationCase.name)}`);
    }
    names.add(validationCase.name);
  }
}

export function validatePinnedCanaries(canaries: readonly PinnedCanary[]): void {
  const names = new Set<string>();
  for (const canary of canaries) {
    if (canary.name.length === 0) {
      throw new TypeError("pinned canary name must not be empty");
    }
    if (names.has(canary.name)) {
      throw new TypeError(`duplicate pinned canary ${JSON.stringify(canary.name)}`);
    }
    names.add(canary.name);
  }
}

export function validateExecutorTimeout(timeoutMs: number): number {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError(`executor timeout must be positive and finite, got ${timeoutMs}`);
  }
  return timeoutMs;
}

export async function corpusContainsPinnedCanaries(
  corpus: readonly ValidationCase[],
  pinnedCanaries: readonly PinnedCanary[],
): Promise<boolean> {
  if (pinnedCanaries.length === 0) {
    return true;
  }

  const corpusByName = new Map(corpus.map((corpusCase) => [corpusCase.name, corpusCase]));
  const pinnedCases: ValidationCase[] = [];
  for (const canary of pinnedCanaries) {
    const corpusCase = corpusByName.get(canary.name);
    if (corpusCase === undefined || !corpusCase.mandatoryCanary) {
      return false;
    }
    pinnedCases.push({ ...corpusCase, mandatoryCanary: true });
  }

  const [corpusCanaryVersion, pinnedCanaryVersion] = await Promise.all([
    computeCorpusVersion(pinnedCases),
    computeCorpusVersion(
      pinnedCanaries.map((canary) => ({
        name: canary.name,
        session: canary.session,
        mandatoryCanary: true,
      })),
    ),
  ]);
  return corpusCanaryVersion === pinnedCanaryVersion;
}

export function evaluationCases(
  corpus: readonly ValidationCase[],
  pinnedCanaries: readonly PinnedCanary[],
): readonly ValidationCase[] {
  const pinnedNames = new Set(pinnedCanaries.map((canary) => canary.name));
  return [
    ...pinnedCanaries.map((canary) => ({
      name: canary.name,
      session: canary.session,
      mandatoryCanary: true,
    })),
    ...corpus
      .filter((validationCase) => !pinnedNames.has(validationCase.name))
      .map(({ name, session }) => ({ name, session, mandatoryCanary: false })),
  ];
}
