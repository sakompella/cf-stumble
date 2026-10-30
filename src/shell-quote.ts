/** Standalone so project provisioning need not import `harness-build.ts`. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
