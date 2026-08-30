const gitObjectId = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;

export class HarnessCommitId {
  readonly value: string;

  private constructor(value: string) {
    this.value = value;
  }

  static parse(value: string): HarnessCommitId | undefined {
    return gitObjectId.test(value) ? new HarnessCommitId(value) : undefined;
  }
}
