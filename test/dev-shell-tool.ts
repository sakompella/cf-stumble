import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);

    return true;
  } catch {
    return false;
  }
}

export function devShellTool(name: string): string {
  if (process.env["IN_NIX_SHELL"] === undefined) {
    throw new Error(
      `The tests need the Nix dev shell: run "nix develop -c pnpm verify" (missing ${name}).`,
    );
  }

  const found = (process.env["PATH"] ?? "")
    .split(delimiter)
    .map((directory) => join(directory, name))
    .find(isExecutable);

  if (found === undefined) {
    throw new Error(`${name} is not in the Nix dev shell; add it to devShells in flake.nix.`);
  }

  return found;
}
