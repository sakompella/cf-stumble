/**
 * Every element the owner acts on, and every element that shows a recorded result, carries one
 * stable identifier. The page renders what a reader must observe rather than keeping it in a
 * script variable, so a browser test reads the same values the owner reads.
 *
 * This map is the single source. The markup, the inline script, and the tests all use it, so an
 * identifier cannot drift between what the page renders and what a test looks for. Elements a turn
 * creates while it streams — one block per message, one collapsible per tool call — carry classes
 * rather than identifiers, because there is no fixed number of them to name.
 */
export const OWNER_PAGE_IDS = {
  root: "owner-page",
  layout: "owner-layout",
  pageError: "page-error",

  sidebar: "project-sidebar",
  sidebarToggle: "project-sidebar-toggle",
  projectList: "project-list",
  projectListStatus: "project-list-status",
  githubState: "github-connection-state",
  githubDetail: "github-connection-detail",
  githubVerificationLink: "github-verification-link",
  authorizeButton: "github-authorize-button",
  completeAuthorizationButton: "github-authorize-complete-button",
  connectRepositoryInput: "connect-repository-input",
  connectButton: "connect-project-button",
  connectStatus: "connect-project-status",

  conversation: "conversation",
  messageList: "conversation-messages",
  conversationProject: "conversation-project",
  conversationState: "conversation-state",
  threadRevision: "thread-revision",
  threadTurnActive: "thread-turn-active",
  threadMessageCount: "thread-message-count",
  promptInput: "prompt-input",
  sendTurnButton: "send-turn-button",
  cancelTurnButton: "cancel-turn-button",
  turnState: "turn-state",
  freshThreadButton: "fresh-thread-button",
  freshThreadStatus: "fresh-thread-status",

  generationDrawer: "generation-drawer",
  refreshStatusButton: "refresh-status-button",
  activeGenerationLabel: "active-generation-label",
  activeGenerationCommit: "active-generation-commit",
  activeGenerationStatus: "active-generation-status",
  generationEpoch: "generation-epoch",
  statusStatus: "status-status",

  candidateCommitInput: "candidate-commit-input",
  submitCandidateButton: "submit-candidate-button",
  submitStatus: "submit-status",
  submitGenerationLabel: "submit-generation-label",
  submitEpoch: "submit-epoch",
  submitPreparation: "submit-preparation",

  activateLabelInput: "activate-label-input",
  activateButton: "activate-button",
  activateStatus: "activate-status",
  activateSentEpoch: "activate-sent-epoch",
  activateEffect: "activate-effect",

  rollbackLabelInput: "rollback-label-input",
  rollbackButton: "rollback-button",
  rollbackStatus: "rollback-status",
  rollbackSentEpoch: "rollback-sent-epoch",
  rollbackEffect: "rollback-effect",

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
} as const;

export type OwnerPageId = (typeof OWNER_PAGE_IDS)[keyof typeof OWNER_PAGE_IDS];

/** Every identifier the static markup must contain. */
export const OWNER_PAGE_ELEMENT_IDS: readonly OwnerPageId[] = Object.values(OWNER_PAGE_IDS);

/**
 * The classes the streaming conversation writes. A frame arriving during a turn creates elements,
 * so these are how a reader — and a browser test — names something the markup could not declare.
 */
export const OWNER_PAGE_CLASSES = {
  message: "message",
  toolCall: "tool-call",
  toolOutput: "tool-output",
  diffLine: "diff-line",
  projectButton: "project-button",
  selectedProject: "selected",
} as const;
