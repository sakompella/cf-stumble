export type SessionDocument = string;

export type SessionRecord = {
  readonly sessionId: string;
  readonly document: SessionDocument | undefined;
  readonly revision: number;
  readonly turnActive: boolean;
  readonly turnDeadlineAt: number | undefined;
};

export type SessionProblem =
  | {
      readonly code: "stale-revision";
      readonly sessionId: string;
      readonly currentRevision: number;
    }
  | { readonly code: "turn-conflict"; readonly sessionId: string; readonly deadlineAt: number }
  | { readonly code: "turn-not-active"; readonly sessionId: string }
  | { readonly code: "turn-expired"; readonly sessionId: string; readonly deadlineAt: number };

export type SessionResult =
  | { readonly ok: true; readonly session: SessionRecord }
  | { readonly ok: false; readonly problem: SessionProblem };
