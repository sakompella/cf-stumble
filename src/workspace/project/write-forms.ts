export type WriteForm = (args: readonly string[]) => boolean;

export const writesNever: WriteForm = () => false;

export const writesAlways: WriteForm = () => true;

const SHORT_FLAG_CLUSTER = /^-[^-]/u;

function hasShortFlag(args: readonly string[], letter: string): boolean {
  return args.some((arg) => SHORT_FLAG_CLUSTER.test(arg) && arg.includes(letter));
}

export const sedWrites: WriteForm = (args) =>
  args.some((arg) => arg.startsWith("--in-place") || arg.includes("w")) ||
  hasShortFlag(args, "i") ||
  hasShortFlag(args, "f");

export const yqWrites: WriteForm = (args) => args.includes("--inplace") || hasShortFlag(args, "i");

export const sortWrites: WriteForm = (args) =>
  args.some((arg) => arg.startsWith("-o") || arg.startsWith("--output"));

export const awkWrites: WriteForm = (args) =>
  args.some((arg) => arg.includes(">") || arg.includes("|"));

export const curlWrites: WriteForm = (args) =>
  args.some(
    (arg) => /^--(?:output|remote-name|cookie-jar)/u.test(arg) || arg === "-o" || arg === "-c",
  ) || hasShortFlag(args, "O");

export const xanWrites: WriteForm = (args) => args[0] === "split" || args[0] === "partition";
