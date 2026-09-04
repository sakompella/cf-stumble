/**
 * POSIX single-quote escaping for text that reaches `/bin/sh`.
 *
 * This lives in its own module because two unrelated planners emit shell text: the harness build
 * and project provisioning. A build must not see or touch project files, so the project planner
 * importing `harness-build.ts` just to reach this helper would tie the two together for no reason.
 */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
