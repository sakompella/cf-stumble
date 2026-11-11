import type { GitCliResult, GitClient } from "@cloudflare/computer/git";
import { matching, matchesAny, resolveSpecs } from "./git-pathspec.js";
import { failure, pathspecError } from "./git-result.js";
import { changeSelection, stage } from "./git-stage.js";
import type { StatusLine } from "./git-status.js";

const FALL_BACK: GitCliResult = {
  stdout: "",
  stderr: "git commit: committing only some paths while others are staged is not supported\n",
  exitCode: 129,
};

async function headFiles(client: GitClient, dir: string): Promise<string[]> {
  try {
    return await client.lsFiles({ dir, ref: "HEAD" });
  } catch {
    return [];
  }
}

export async function stagePathspecs(
  client: GitClient,
  dir: string,
  prefix: string,
  paths: readonly string[],
  lines: readonly StatusLine[],
): Promise<GitCliResult | undefined> {
  const specs = resolveSpecs(paths, prefix);

  if ("outside" in specs) return failure(`fatal: '${specs.outside}' is outside repository\n`);

  const known = [...(await client.lsFiles({ dir })), ...(await headFiles(client, dir))];

  const missed = specs.flatMap((spec, index) =>
    spec !== "." && matching(known, spec).length === 0 ? [paths[index] ?? spec] : [],
  );

  if (missed.length > 0) return pathspecError(missed);

  const staged = lines.some(
    (line) => line.x !== " " && line.x !== "?" && !matchesAny(line.path, specs),
  );

  if (staged) return FALL_BACK;

  await stage(
    client,
    dir,
    changeSelection(
      lines.filter((line) => line.x !== "?"),
      specs,
    ),
    false,
  );

  return undefined;
}
