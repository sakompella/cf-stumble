export type ProjectBudget = Readonly<{ remainingMs: number }>;

export function parseProjectBudget(budget: ProjectBudget | undefined): number | undefined {
  return budget !== undefined && Number.isFinite(budget.remainingMs) && budget.remainingMs > 0
    ? budget.remainingMs
    : undefined;
}
