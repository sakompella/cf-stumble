import { GITHUB_CLI_CONFIG_DIRECTORY } from "../../workspace-layout.js";

const GITHUB_HOST = "github.com";

const HOST_LINE = /^(\S+):\s*$/u;

const TOKEN_LINE = /^\s+oauth_token:\s*(\S+)\s*$/u;

function githubTokenFromHosts(hosts: string): string | undefined {
  let host: string | undefined = undefined;

  for (const line of hosts.split("\n")) {
    const entry = HOST_LINE.exec(line);

    if (entry !== null) host = entry[1];
    else if (host === GITHUB_HOST) {
      const token = TOKEN_LINE.exec(line)?.[1];

      if (token !== undefined) return token;
    }
  }

  return undefined;
}

interface GitHubHostsFile {
  readFile(path: string, encoding: "utf8"): Promise<string>;
}

export async function readGitHubToken(
  fs: GitHubHostsFile,
  fallbackToken?: string,
): Promise<string | undefined> {
  const hosts = await fs
    .readFile(`${GITHUB_CLI_CONFIG_DIRECTORY}/hosts.yml`, "utf8")
    .catch(() => "");

  return githubTokenFromHosts(hosts) ?? fallbackToken;
}
