export function without(argv: readonly string[], flags: readonly string[]): string[] {
  return argv.filter((arg) => !flags.includes(arg));
}
