const gitObjectId = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

declare const harnessCommitBrand: unique symbol;

export type HarnessCommit = string & {
  readonly [harnessCommitBrand]: "HarnessCommit";
};

export function isHarnessCommit(value: string): value is HarnessCommit {
  return gitObjectId.test(value);
}

export function parseHarnessCommit(value: string): HarnessCommit | undefined {
  return isHarnessCommit(value) ? value : undefined;
}
