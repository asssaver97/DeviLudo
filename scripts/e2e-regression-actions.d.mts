export type RegressionPostcondition = Readonly<Record<string, unknown>>;
export type PlannedRegressionAction = Readonly<Record<string, unknown> & {
  type: string;
  postconditions: readonly RegressionPostcondition[];
}>;
export type PlannedRegressionCandidate = Readonly<{
  source: "PLANNED_CORE_JOURNEY";
  estimatedDurationMs: number;
  actions: readonly PlannedRegressionAction[];
}>;

export function plannedCoreRegressionCandidates(manifest: unknown): readonly PlannedRegressionCandidate[];
