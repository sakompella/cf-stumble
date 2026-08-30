const gitObjectId = /^[0-9a-f]{40}$/u;

declare const harnessCommitBrand: unique symbol;

export type HarnessCommit = string & {
  readonly [harnessCommitBrand]: "HarnessCommit";
};

export function parseHarnessCommit(value: string): HarnessCommit | undefined {
  if (!gitObjectId.test(value)) {
    return undefined;
  }

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: gitObjectId accepts exactly the HarnessCommit syntax.
  return value as HarnessCommit;
}
