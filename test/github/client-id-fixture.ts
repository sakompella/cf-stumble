import { parseGitHubClientId, type GitHubClientId } from "../../src/github/index.js";

export function clientIdOf(value: string): GitHubClientId {
  const clientId = parseGitHubClientId(value);

  if (clientId === undefined) throw new Error(`${JSON.stringify(value)} must be a client id`);

  return clientId;
}
