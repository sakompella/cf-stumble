import type { ConversationProblemCode } from "../../api/problems.js";
import { refusalText, type Refusal } from "./api.js";

const KEEPS_MESSAGE = {
  "invalid-project-id": false,
  "unknown-project-id": false,
  "invalid-message": false,
  "workspace-busy": false,
  "thread-replaced": false,
  "no-active-generation": true,
  "mount-failed": true,
  "generation-failed": true,
} as const satisfies Record<ConversationProblemCode, boolean>;

export type SendRefusal = Readonly<{ wording: string; keepsMessage: boolean }>;

function isSendProblem(code: string): code is ConversationProblemCode {
  return Object.hasOwn(KEEPS_MESSAGE, code);
}

export function sendRefusal(refusal: Refusal, status: number): SendRefusal {
  return {
    wording: refusalText(refusal),
    keepsMessage:
      refusal.kind === "problem" && isSendProblem(refusal.code)
        ? KEEPS_MESSAGE[refusal.code]
        : status >= 500,
  };
}
