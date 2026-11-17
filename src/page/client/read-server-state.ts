import { FetchChatGPT, FetchGitHub, FetchProjects, FetchStatus } from "./commands.js";
import { FetchBackend } from "./commands-backend.js";

export const readServerState = () => [
  FetchStatus(),
  FetchProjects(),
  FetchGitHub(),
  FetchChatGPT(),
  FetchBackend(),
];
