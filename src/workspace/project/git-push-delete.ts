import type { GitCliInput } from "@cloudflare/computer/git";

export function pushDelete(input: GitCliInput): GitCliInput {
  const colon = input.argv.findIndex((arg, index) => index > 0 && /^:[^:]+$/u.test(arg));

  if (colon === -1) return input;

  return {
    ...input,
    argv: input.argv.flatMap((arg, index) =>
      index === colon ? ["--delete", arg.slice(1)] : [arg],
    ),
  };
}
