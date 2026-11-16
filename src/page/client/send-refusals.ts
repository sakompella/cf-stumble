import type { ConversationProblemCode } from "../../api/problems.js";
import { refusalText, type Refusal } from "./api.js";

const SEND_REFUSALS = {
  "invalid-project-id": { wording: "rejected: invalid-project-id", keepsMessage: false },
  "unknown-project-id": { wording: "rejected: unknown-project-id", keepsMessage: false },
  "invalid-message": { wording: "rejected: invalid-message", keepsMessage: false },
  "workspace-busy": {
    wording: "busy: the workspace is resetting; send again once it finishes",
    keepsMessage: false,
  },
  "no-active-generation": {
    wording: "no active generation: activate one in the generation controls",
    keepsMessage: true,
  },
  "mount-failed": { wording: "rejected: mount-failed", keepsMessage: true },
  "generation-failed": { wording: "rejected: generation-failed", keepsMessage: true },
} as const satisfies Record<
  ConversationProblemCode,
  Readonly<{ wording: string; keepsMessage: boolean }>
>;

export type SendRefusal = Readonly<{ wording: string; keepsMessage: boolean }>;

function isSendProblem(code: string): code is ConversationProblemCode {
  return Object.hasOwn(SEND_REFUSALS, code);
}

export function sendRefusal(refusal: Refusal, status: number): SendRefusal {
  return refusal.kind === "problem" && isSendProblem(refusal.code)
    ? SEND_REFUSALS[refusal.code]
    : { wording: refusalText(refusal), keepsMessage: status >= 500 };
}
