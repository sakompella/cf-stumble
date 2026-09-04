/**
 * Every element the owner acts on, and every element that shows a recorded result, carries one
 * stable identifier. The page renders what a reader must observe rather than keeping it in a
 * script variable, so a browser test reads the same values the owner reads.
 *
 * This map is the single source. The markup, the inline script, and the tests all use it, so an
 * identifier cannot drift between what the page renders and what a test looks for.
 */
export const OWNER_PAGE_IDS = {
  root: "owner-page",

  refreshStatusButton: "refresh-status-button",
  activeGenerationLabel: "active-generation-label",
  activeGenerationCommit: "active-generation-commit",
  activeGenerationStatus: "active-generation-status",
  generationEpoch: "generation-epoch",
  statusStatus: "status-status",
  statusRaw: "status-raw",

  projectIdInput: "project-id-input",
  loadThreadButton: "load-thread-button",
  freshThreadButton: "fresh-thread-button",
  threadStatus: "thread-status",
  threadProject: "thread-project",
  threadRevision: "thread-revision",
  threadTurnActive: "thread-turn-active",
  threadMessageCount: "thread-message-count",
  threadRaw: "thread-raw",

  candidateCommitInput: "candidate-commit-input",
  submitCandidateButton: "submit-candidate-button",
  submitStatus: "submit-status",
  submitRequestId: "submit-request-id",
  submitGenerationLabel: "submit-generation-label",
  submitEpoch: "submit-epoch",
  submitPreparation: "submit-preparation",
  submitRaw: "submit-raw",

  activateLabelInput: "activate-label-input",
  activateButton: "activate-button",
  activateStatus: "activate-status",
  activateRequestId: "activate-request-id",
  activateSentEpoch: "activate-sent-epoch",
  activateEffect: "activate-effect",
  activateRaw: "activate-raw",

  rollbackLabelInput: "rollback-label-input",
  rollbackButton: "rollback-button",
  rollbackStatus: "rollback-status",
  rollbackRequestId: "rollback-request-id",
  rollbackSentEpoch: "rollback-sent-epoch",
  rollbackEffect: "rollback-effect",
  rollbackRaw: "rollback-raw",

  refreshRecoveryButton: "refresh-recovery-button",
  recoveryNotice: "recovery-notice",
  recoveryPresence: "recovery-presence",
  recoveryId: "recovery-id",
  recoveryPhase: "recovery-phase",
  recoveryResult: "recovery-result",
  recoveryFailedLabel: "recovery-failed-generation-label",
  recoveryFallbackLabel: "recovery-fallback-generation-label",
  recoveryAttempts: "recovery-attempts-used",
  recoveryErrorCount: "recovery-error-count",
  recoveryStartedAt: "recovery-started-at",
  recoveryAwaiting: "recovery-awaiting-external-report",
  recoveryRaw: "recovery-raw",

  pageError: "page-error",
} as const;

export type OwnerPageId = (typeof OWNER_PAGE_IDS)[keyof typeof OWNER_PAGE_IDS];

/** Every identifier the static markup must contain. */
export const OWNER_PAGE_ELEMENT_IDS: readonly OwnerPageId[] = Object.values(OWNER_PAGE_IDS);
