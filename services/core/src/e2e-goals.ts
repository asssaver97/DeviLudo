import { createHash } from "node:crypto";
import type { E2eGoal, E2eGoalDelta } from "@/lib/product/contracts";
import { specificationRequirementCatalog } from "@/lib/product/test-manifest";

export function initialE2eGoals(specification: Readonly<Record<string, unknown>>): readonly E2eGoal[] {
  return Object.freeze(specificationRequirementCatalog(specification).map(requirement => Object.freeze({
    id: requirement.requirementId,
    description: requirement.description,
    source: requirement.source,
  })));
}

export function mergeE2eGoals(
  current: readonly E2eGoal[],
  delta: E2eGoalDelta,
  specification: Readonly<Record<string, unknown>>,
): readonly E2eGoal[] {
  const byId = new Map(current.map(goal => [goal.id, goal]));
  const referenced = [...delta.replace.map(goal => goal.id), ...delta.retire];
  if (new Set(referenced).size !== referenced.length || referenced.some(id => !byId.has(id))) {
    throw new Error("Test Agent referenced an unknown or duplicate E2E goal id");
  }
  for (const id of delta.retire) byId.delete(id);
  for (const replacement of delta.replace) {
    byId.set(replacement.id, Object.freeze({ ...replacement }));
  }
  for (const addition of delta.add) {
    const id = goalId(addition.source, addition.description);
    const existing = byId.get(id);
    if (existing && existing.description !== addition.description) {
      throw new Error("E2E goal id collision");
    }
    byId.set(id, Object.freeze({ id, ...addition }));
  }
  // A confirmed document change may introduce a requirement even when the Test
  // Agent omits an additive hint. Never let that omission weaken the gate.
  for (const goal of initialE2eGoals(specification)) {
    if (![...byId.values()].some(candidate => candidate.description === goal.description)) {
      byId.set(goal.id, goal);
    }
  }
  return Object.freeze([...byId.values()]);
}

export function e2eGoalsDigest(goals: readonly E2eGoal[]): string {
  const canonical = [...goals]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map(goal => ({ id: goal.id, description: goal.description, source: goal.source }));
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical)).digest("hex")}`;
}

function goalId(source: E2eGoal["source"], description: string): string {
  const digest = createHash("sha256").update(source).update("\0").update(description.normalize("NFKC").trim()).digest("hex").slice(0, 16);
  return `goal-${source.toLowerCase().replace("_", "-")}-${digest}`;
}
