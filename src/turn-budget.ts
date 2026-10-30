/** The Supervisor aborts a conversation's run once it has been active this long. */
export const PROJECT_RUN_DEADLINE_MS = 8 * 60 * 1_000;

/**
 * How long a project capability that names no remaining time keeps the container from its idle
 * stop. It outlasts the run deadline so a run that reaches its bound still ends inside it.
 */
export const PROJECT_TURN_LEASE_MS = 9 * 60 * 1_000;
