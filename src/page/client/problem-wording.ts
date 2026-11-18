import type { ErrorCode, ProblemCode } from "../../api/problems.js";
import {
  MAX_REPOSITORY_BLOB_BYTES,
  MAX_REPOSITORY_BLOB_COUNT,
  MAX_REPOSITORY_SIZE_KB,
} from "../../repository-limits.js";

const number = (value: number): string => value.toLocaleString("en-US");

const RETRY_LATER = "Try again in a moment.";

const PROBLEM_WORDING = {
  "invalid-project-id": "That project id is not valid.",
  "unknown-project-id":
    "This project is not connected any more. Reload the page for the current list.",
  "invalid-message": "The message is empty or longer than 100,000 bytes.",
  "no-active-generation": "No generation is active. Activate one in the generation controls.",
  "mount-failed": "The active generation did not start. Try again, or roll back to an earlier one.",
  "generation-failed":
    "The active generation failed on this request. Try again, or roll back to an earlier one.",
  "workspace-busy": `The workspace is resetting or changing. ${RETRY_LATER}`,
  "invalid-repository-url":
    "That is not a GitHub repository address. Use https://github.com/owner/name.",
  "repository-not-accessible":
    "GitHub says this repository is not accessible. Check the name for a typo; a private repository needs a token that can read it.",
  "workspace-unavailable": `The workspace is not reachable. ${RETRY_LATER}`,
  "tooling-missing": "The workspace image lacks a tool that connecting a repository needs.",
  "repository-too-large": `This repository is over the workspace limits: more than ${number(MAX_REPOSITORY_BLOB_COUNT)} files, more than ${number(MAX_REPOSITORY_BLOB_BYTES / 1_000_000)} MB of files, or more than ${number(MAX_REPOSITORY_SIZE_KB / 1_000_000)} GB on GitHub.`,
  "provisioning-failed": `The repository could not be copied into the workspace. ${RETRY_LATER}`,
  "run-active": "A run is active. Cancel it or wait until it ends.",
  "not-configured":
    "GitHub device sign-in is not set up on this Worker, so there is nothing to authorize.",
  "provider-unavailable": `The provider did not answer. ${RETRY_LATER}`,
  "no-pending-authorization": "No authorization is waiting. Press Authorize GitHub first.",
  "authorization-expired": "The GitHub code expired. Press Authorize GitHub for a new one.",
  "authorization-denied":
    "GitHub refused the authorization. Press Authorize GitHub to start again.",
  "unknown-generation": "No generation has that label.",
  "not-ready": "That generation is not ready. Prepare it first.",
  "not-previously-active": "Only a generation that was active before can be rolled back to.",
  "facet-compatibility-mismatch":
    "That generation's stored data does not match the active one, so the switch is refused.",
  "stale-epoch":
    "The generation state changed after the page read it. Refresh the status and try again.",
  "drops-active-commit":
    "That generation does not contain the active generation's commit, so switching would drop work.",
  "no-sign-in": "No ChatGPT sign-in is waiting. Press Log in with ChatGPT first.",
  expired: "The ChatGPT sign-in expired. Start it again.",
  "bad-address":
    "That is not the address ChatGPT sent you to. Paste the whole address from the browser.",
  "provider-refused": "ChatGPT refused the sign-in. Start it again.",
  "wrong-sign-in":
    "That address belongs to another sign-in. Start again and paste the new address.",
  "missing-code": "That address has no sign-in code. Paste the final address.",
  "missing-client": "This Worker has no ChatGPT client configured.",
  "exchange-refused": "ChatGPT refused to turn the code into a login. Start the sign-in again.",
  "exchange-unavailable": `ChatGPT did not answer. ${RETRY_LATER}`,
  "missing-scope":
    "The login lacks a permission the harness needs. Sign in again and accept every permission.",
} as const satisfies Readonly<Record<ProblemCode, string>>;

const ERROR_WORDING = {
  "invalid-submission-request": "The Worker could not read the generation submission.",
  "invalid-activation-request": "The Worker could not read the activation request.",
  "invalid-rollback-request": "The Worker could not read the rollback request.",
  "invalid-connect-request": "The Worker could not read the connect request.",
  "invalid-message-request": "The Worker could not read the message request.",
  "invalid-events-request": "The Worker could not read the events request.",
  "invalid-entries-request": "The Worker could not read the earlier messages request.",
  "invalid-chatgpt-request": "The Worker could not read the ChatGPT request.",
  "invalid-backend-request": "The Worker could not read the workspace container request.",
  "cross-origin-request": "The Worker refused a request that came from another site.",
  "not-found": "The Worker has nothing at that address.",
  "infrastructure-interrupted": `The platform interrupted the submit before it finished. ${RETRY_LATER}`,
  "internal-error": `The Worker failed on its own. ${RETRY_LATER}`,
} as const satisfies Readonly<Record<ErrorCode, string>>;

function isProblemCode(code: string): code is ProblemCode {
  return Object.hasOwn(PROBLEM_WORDING, code);
}

function isErrorCode(code: string): code is ErrorCode {
  return Object.hasOwn(ERROR_WORDING, code);
}

export function problemWording(code: string): string | undefined {
  return isProblemCode(code) ? PROBLEM_WORDING[code] : undefined;
}

export function errorWording(code: string): string | undefined {
  return isErrorCode(code) ? ERROR_WORDING[code] : undefined;
}
