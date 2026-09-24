/**
 * The wall-clock budget for one project turn, shared by the Supervisor and the main facet.
 *
 * The lease outlasts the deadline so a turn that reaches its bound can still release the lease it
 * owns before another turn takes the project slot. Both values stay below the platform request edge
 * observed during deployment.
 */
export const PROJECT_TURN_DEADLINE_MS = 8 * 60 * 1_000;

export const PROJECT_TURN_LEASE_MS = 9 * 60 * 1_000;

export const PROJECT_TURN_DEADLINE_MINUTES = PROJECT_TURN_DEADLINE_MS / (60 * 1_000);
