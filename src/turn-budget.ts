/**
 * The lease outlasts the deadline so a turn that reaches its bound can still release the lease
 * before another turn takes the project slot. Both stay below the platform request edge.
 */
export const PROJECT_TURN_DEADLINE_MS = 8 * 60 * 1_000;

export const PROJECT_TURN_LEASE_MS = 9 * 60 * 1_000;

export const PROJECT_TURN_DEADLINE_MINUTES = PROJECT_TURN_DEADLINE_MS / (60 * 1_000);
