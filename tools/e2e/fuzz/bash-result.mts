import type { Outcome } from "./git-oracle.mts";

const FAILED = /<harness>\n\[error\] Command exited with code (\d+)\n<\/harness>$/u;

export function parseBash(content: string): Outcome {
  const failed = FAILED.exec(content);

  if (failed === null) return { output: content, code: 0 };

  return { output: content.slice(0, failed.index), code: Number(failed[1]) };
}
