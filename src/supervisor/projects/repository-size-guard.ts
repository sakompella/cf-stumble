import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import {
  lookupRepositorySize,
  parseGitHubToken,
  repositorySizeReason,
} from "../../github/index.js";
import type { PublicRepositoryUrl } from "../../project-catalog.js";
import type { GitHubConnectionEnvironment } from "./github-connection.js";

export type RepositorySizeGuard = (repositoryUrl: PublicRepositoryUrl) => Effect.Effect<boolean>;

export function repositorySizeGuard(
  environment: Pick<GitHubConnectionEnvironment, "fallbackToken" | "fetcher">,
): RepositorySizeGuard {
  const token = parseGitHubToken(environment.fallbackToken);

  return (repositoryUrl) =>
    Effect.gen(function* () {
      const lookup = yield* Effect.result(
        lookupRepositorySize(repositoryUrl, token, environment.fetcher),
      );

      const measured = Result.isSuccess(lookup) ? lookup.success : undefined;
      const reason = measured === undefined ? undefined : repositorySizeReason(measured);

      return reason === undefined || reason === "within-limits";
    });
}
