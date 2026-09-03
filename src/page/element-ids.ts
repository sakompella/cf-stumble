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

  sessionIdInput: "session-id-input",
  loadSessionButton: "load-session-button",
  sessionStatus: "session-status",
  sessionRevision: "session-revision",
  sessionTurnActive: "session-turn-active",
  sessionDocument: "session-document",

  chatPromptInput: "chat-prompt-input",
  chatSendButton: "chat-send-button",
  turnStatus: "turn-status",
  chatReply: "chat-reply",
  turnDiff: "turn-diff",
  commandList: "command-list",
  commandsEmpty: "commands-empty",
  turnRaw: "turn-raw",

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

/**
 * One executed command is a repeated row, so its identifiers carry the row index. The script
 * builds them from these same parts, and a browser test reads `command-0-exit-code` for the first
 * command of the last turn.
 */
export const COMMAND_ID_PREFIX = "command-";

export const COMMAND_ID_SUFFIXES = {
  command: "-command",
  exitCode: "-exit-code",
  stdout: "-stdout",
  stderr: "-stderr",
} as const;

export type CommandElementIds = {
  readonly row: string;
  readonly command: string;
  readonly exitCode: string;
  readonly stdout: string;
  readonly stderr: string;
};

export function commandElementIds(index: number): CommandElementIds {
  const row = `${COMMAND_ID_PREFIX}${index}`;
  return {
    row,
    command: `${row}${COMMAND_ID_SUFFIXES.command}`,
    exitCode: `${row}${COMMAND_ID_SUFFIXES.exitCode}`,
    stdout: `${row}${COMMAND_ID_SUFFIXES.stdout}`,
    stderr: `${row}${COMMAND_ID_SUFFIXES.stderr}`,
  };
}
