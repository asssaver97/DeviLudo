import { jobCapabilities, routeJob, type JobKind } from "@/lib/runtime/job-routing";
import type { ServerOperatingSystem } from "@/lib/runtime/server-pools";

export const WORKFLOW_STATES = [
  "DRAFT",
  "ANALYZING",
  "DESIGNING",
  "UI_DESIGNING",
  "DEVELOPING",
  "BUILDING",
  "TEST_PLANNING",
  "TESTING",
  "RELEASE_APPROVAL_PENDING",
  "STEAM_PREPARING",
  "STEAM_PUBLISHING",
  "SUCCEEDED",
  "BLOCKED",
  "STOPPED",
  "FAILED",
  "CANCELLED",
] as const;
export type WorkflowState = typeof WORKFLOW_STATES[number];

export type WorkflowSnapshot = Readonly<{
  id: string;
  workspaceId: string;
  projectId: string;
  state: WorkflowState;
  profile: "VALIDATE" | "RELEASE";
  targetPlatforms: readonly ServerOperatingSystem[];
  completedE2e: readonly ServerOperatingSystem[];
}>;

export type WorkflowEvent =
  | Readonly<{ kind: "SPEC_APPROVED" }>
  | Readonly<{ kind: "ASSETS_READY"; predecessorJobId: string }>
  | Readonly<{ kind: "ASSET_RERUN_REQUESTED" }>
  | Readonly<{ kind: "RELEASE_APPROVED"; approvalId: string }>
  | Readonly<{ kind: "STEAM_PREPARATION_SAVED"; preparationId: string }>
  | Readonly<{ kind: "RELEASE_SKIPPED" }>
  | Readonly<{ kind: "CANCEL_REQUESTED" }>
  | Readonly<{
      kind: "JOB_SUCCEEDED";
      jobId: string;
      jobKind: JobKind;
      agentRole?: "DESIGN" | "UI_DESIGN" | "DEVELOPMENT" | "TEST" | "PUBLISHING";
      purpose?: "DESIGN" | "UI_DESIGN" | "DEVELOPMENT" | "TEST_PLAN" | "TEST_VERDICT" | "PUBLISHING";
      verdict?: "PASS" | "FAIL" | "BLOCKED" | "REPLAN";
      targetOperatingSystem: ServerOperatingSystem | null;
      /** Agent completion waits here only when this run has auto-generated art. */
      waitForAssets?: boolean;
    }>
  | Readonly<{ kind: "JOB_FAILED"; jobKind: JobKind; reason: string }>
  | Readonly<{ kind: "STAGE_RERUN_REQUESTED"; stage: RerunStage; signalId: string }>;

/**
 * Delivery chain in order. Rerunning a stage supersedes it and everything after
 * it, so this order is load-bearing and must match `deviludo.delivery_stages`.
 */
export const DELIVERY_STAGES = [
  "GAME_DESIGN",
  "UI_DESIGN",
  "AGENT_TURN",
  "BUILD",
  "E2E_PLATFORM_RUN",
  "STEAM_PUBLISH",
] as const;
export type RerunStage = typeof DELIVERY_STAGES[number];

export function deliveryStagesFor(profile: "VALIDATE" | "RELEASE"): readonly RerunStage[] {
  void profile;
  return DELIVERY_STAGES;
}

// Workflow state a stage occupies while it runs.
const STAGE_RUNNING_STATE: Readonly<Record<RerunStage, WorkflowState>> = Object.freeze({
  GAME_DESIGN: "DESIGNING",
  UI_DESIGN: "UI_DESIGNING",
  AGENT_TURN: "DEVELOPING",
  BUILD: "BUILDING",
  E2E_PLATFORM_RUN: "TESTING",
  STEAM_PUBLISH: "STEAM_PUBLISHING",
});

// Stages that fan out one job per target platform.
const PER_PLATFORM_STAGES: ReadonlySet<RerunStage> = new Set<RerunStage>(["E2E_PLATFORM_RUN"]);

// Per-platform progress that a rerun of a given stage invalidates.
const STAGE_PROGRESS_KEY: Readonly<Partial<Record<RerunStage, keyof WorkflowSnapshot>>> = Object.freeze({
  E2E_PLATFORM_RUN: "completedE2e",
});

export type EnqueueCommand = Readonly<{
  jobKind: JobKind;
  targetOperatingSystem: ServerOperatingSystem | null;
  poolKind: ReturnType<typeof routeJob>;
  requiredCapabilities: readonly string[];
  exclusive: boolean;
  idempotencyKey: string;
  agentRole: "DESIGN" | "UI_DESIGN" | "DEVELOPMENT" | "TEST" | "PUBLISHING" | null;
  purpose: "DESIGN" | "UI_DESIGN" | "DEVELOPMENT" | "TEST_PLAN" | "TEST_VERDICT" | "PUBLISHING" | null;
}>;

export type WorkflowTransition = Readonly<{
  snapshot: WorkflowSnapshot;
  enqueue: readonly EnqueueCommand[];
}>;

export function initialWorkflowSnapshot(
  id: string,
  workspaceId: string,
  projectId: string,
  profile: "VALIDATE" | "RELEASE" = "VALIDATE",
  targetPlatforms: readonly ServerOperatingSystem[] = ["macos"],
): WorkflowSnapshot {
  if (targetPlatforms.length < 1 || targetPlatforms.length > 3 || new Set(targetPlatforms).size !== targetPlatforms.length) {
    throw new Error("Workflow target platforms are invalid");
  }
  return Object.freeze({
    id,
    workspaceId,
    projectId,
    state: "DRAFT",
    profile,
    targetPlatforms: Object.freeze([...targetPlatforms]),
    completedE2e: Object.freeze([]),
  });
}

export function transitionWorkflow(snapshot: WorkflowSnapshot, event: WorkflowEvent): WorkflowTransition {
  // Reruns legitimately reopen a terminal workflow, so they have to be handled
  // before the terminal-state guard below. Asset work has no job of its own: it
  // re-enters the asynchronous gate and ASSETS_READY resumes at Builder.
  if (event.kind === "STAGE_RERUN_REQUESTED") return rerunStage(snapshot, event.stage, event.signalId);
  if (event.kind === "ASSET_RERUN_REQUESTED") return rerunAssets(snapshot);
  if (["SUCCEEDED", "BLOCKED", "STOPPED", "FAILED", "CANCELLED"].includes(snapshot.state)) {
    return Object.freeze({ snapshot, enqueue: Object.freeze([]) });
  }
  if (event.kind === "CANCEL_REQUESTED") return result({ ...snapshot, state: "CANCELLED" }, []);
  if (event.kind === "JOB_FAILED") return result({ ...snapshot, state: "FAILED" }, []);
  if (event.kind === "SPEC_APPROVED" && snapshot.state === "DRAFT") {
    return result({ ...snapshot, state: "DESIGNING" }, [command(snapshot, "AGENT_TURN", null, "design", "DESIGN", "DESIGN")]);
  }
  if (event.kind === "ASSETS_READY" && snapshot.state === "DEVELOPING") {
    return result(
      { ...snapshot, state: "BUILDING" },
      [command(snapshot, "BUILD", null, `artifact:after:${event.predecessorJobId}`)],
    );
  }
  if (event.kind === "RELEASE_SKIPPED" && snapshot.state === "RELEASE_APPROVAL_PENDING") {
    return result({ ...snapshot, state: "SUCCEEDED" }, []);
  }
  if (event.kind === "RELEASE_APPROVED" && snapshot.state === "RELEASE_APPROVAL_PENDING") {
    return result(
      { ...snapshot, state: "STEAM_PREPARING" },
      [command(snapshot, "AGENT_TURN", null, `publishing:approved:${event.approvalId}`, "PUBLISHING", "PUBLISHING")],
    );
  }
  if (event.kind === "STEAM_PREPARATION_SAVED" && snapshot.state === "STEAM_PREPARING") {
    return result({ ...snapshot, state: "STEAM_PUBLISHING" },
      [command(snapshot, "STEAM_PUBLISH", null, `publish:after-preparation:${event.preparationId}`)]);
  }
  if (event.kind !== "JOB_SUCCEEDED") throw new Error(`Event ${event.kind} is invalid for ${snapshot.state}`);

  if (snapshot.state === "DESIGNING" && event.jobKind === "AGENT_TURN" && event.agentRole === "DESIGN") {
    return result(
      { ...snapshot, state: "UI_DESIGNING" },
      [command(snapshot, "AGENT_TURN", null, `ui-design:after:${event.jobId}`, "UI_DESIGN", "UI_DESIGN")],
    );
  }
  if (snapshot.state === "UI_DESIGNING" && event.jobKind === "AGENT_TURN" && event.agentRole === "UI_DESIGN") {
    return result(
      { ...snapshot, state: "DEVELOPING" },
      [command(snapshot, "AGENT_TURN", null, `development:after:${event.jobId}`, "DEVELOPMENT", "DEVELOPMENT")],
    );
  }
  if (snapshot.state === "DEVELOPING" && event.jobKind === "AGENT_TURN" && event.agentRole === "DEVELOPMENT") {
    if (event.waitForAssets) return result({ ...snapshot, state: "DEVELOPING" }, []);
    return result(
      { ...snapshot, state: "BUILDING" },
      [command(snapshot, "BUILD", null, `artifact:after:${event.jobId}`)],
    );
  }
  if (snapshot.state === "BUILDING" && event.jobKind === "BUILD") {
    return result(
      { ...snapshot, state: "TEST_PLANNING" },
      [command(snapshot, "AGENT_TURN", null, `test-plan:after:${event.jobId}`, "TEST", "TEST_PLAN")],
    );
  }
  if (snapshot.state === "TEST_PLANNING" && event.jobKind === "AGENT_TURN"
    && event.agentRole === "TEST" && event.purpose === "TEST_PLAN") {
    if (event.verdict === "FAIL") {
      return result(
        { ...snapshot, state: "DEVELOPING", completedE2e: Object.freeze([]) },
        [command(snapshot, "AGENT_TURN", null, `development:test-plan-handoff:${event.jobId}`, "DEVELOPMENT", "DEVELOPMENT")],
      );
    }
    return result(
      { ...snapshot, state: "TESTING" },
      snapshot.targetPlatforms.map(platform => command(
        snapshot, "E2E_PLATFORM_RUN", platform, `e2e:${platform}:after:${event.jobId}`,
      )),
    );
  }
  if (snapshot.state === "TESTING" && event.jobKind === "E2E_PLATFORM_RUN" && event.targetOperatingSystem) {
    const completedE2e = appendPlatform(snapshot.completedE2e, event.targetOperatingSystem);
    if (completedE2e.length < snapshot.targetPlatforms.length) return result({ ...snapshot, completedE2e }, []);
    return result(
      { ...snapshot, state: "TEST_PLANNING", completedE2e },
      [command(snapshot, "AGENT_TURN", null, `test-verdict:after:${event.jobId}`, "TEST", "TEST_VERDICT")],
    );
  }
  if (snapshot.state === "TEST_PLANNING" && event.jobKind === "AGENT_TURN"
    && event.agentRole === "TEST" && event.purpose === "TEST_VERDICT") {
    if (event.verdict === "REPLAN") {
      return result(
        { ...snapshot, state: "TEST_PLANNING", completedE2e: Object.freeze([]) },
        [command(snapshot, "AGENT_TURN", null, `test-replan:after:${event.jobId}`, "TEST", "TEST_PLAN")],
      );
    }
    if (event.verdict === "FAIL") {
      return result(
        { ...snapshot, state: "DEVELOPING" },
        [command(snapshot, "AGENT_TURN", null, `development:test-handoff:${event.jobId}`, "DEVELOPMENT", "DEVELOPMENT")],
      );
    }
    if (event.verdict === "BLOCKED") return result({ ...snapshot, state: "BLOCKED" }, []);
    return result({ ...snapshot, state: "RELEASE_APPROVAL_PENDING" }, []);
  }
  if (snapshot.state === "STEAM_PUBLISHING" && event.jobKind === "STEAM_PUBLISH") {
    return result({ ...snapshot, state: "SUCCEEDED" }, []);
  }
  if (snapshot.state === "STEAM_PREPARING" && event.jobKind === "AGENT_TURN" && event.agentRole === "PUBLISHING") {
    return result(snapshot, []);
  }
  throw new Error(`Job ${event.jobKind} is invalid for ${snapshot.state}`);
}

function rerunAssets(snapshot: WorkflowSnapshot): WorkflowTransition {
  if (!["DEVELOPING", "RELEASE_APPROVAL_PENDING", "BLOCKED", "SUCCEEDED", "FAILED", "CANCELLED"].includes(snapshot.state)) {
    throw new Error("Asset rerun requires an idle delivery or the active asset gate");
  }
  return result({ ...snapshot, state: "DEVELOPING", completedE2e: Object.freeze([]) }, []);
}

/**
 * Re-enter the chain at `stage`. Everything downstream was derived from inputs
 * this rerun replaces, so the caller supersedes those jobs and this drops the
 * matching per-platform progress; only the selected stage is enqueued, and
 * ordinary JOB_SUCCEEDED handling walks the chain forward from there.
 */
function rerunStage(snapshot: WorkflowSnapshot, stage: RerunStage, signalId: string): WorkflowTransition {
  const stages = deliveryStagesFor(snapshot.profile);
  if (!stages.includes(stage)) {
    throw new Error(`Stage ${stage} is not part of the ${snapshot.profile} delivery chain`);
  }
  if (!["RELEASE_APPROVAL_PENDING", "BLOCKED", "SUCCEEDED", "FAILED", "CANCELLED"].includes(snapshot.state)) {
    throw new Error("Stage rerun requires a terminal workflow; cancel the running delivery first");
  }
  const supersededFrom = stages.indexOf(stage);
  const reset: Record<string, unknown> = {};
  for (const downstream of stages.slice(supersededFrom)) {
    const key = STAGE_PROGRESS_KEY[downstream];
    if (key) reset[key] = Object.freeze([]);
  }
  const next = {
    ...snapshot,
    ...reset,
    state: STAGE_RUNNING_STATE[stage],
  } as WorkflowSnapshot;
  const platforms = PER_PLATFORM_STAGES.has(stage) ? snapshot.targetPlatforms : [null];
  const agent = stage === "GAME_DESIGN"
    ? Object.freeze({ role: "DESIGN" as const, purpose: "DESIGN" as const })
    : stage === "UI_DESIGN"
      ? Object.freeze({ role: "UI_DESIGN" as const, purpose: "UI_DESIGN" as const })
      : stage === "AGENT_TURN"
        ? Object.freeze({ role: "DEVELOPMENT" as const, purpose: "DEVELOPMENT" as const })
        : null;
  const jobKind: JobKind = stage === "GAME_DESIGN" || stage === "UI_DESIGN" ? "AGENT_TURN" : stage;
  return result(
    next,
    platforms.map(platform => command(
      snapshot, jobKind, platform, `rerun:${stage}:${platform ?? "all"}:${signalId}`,
      agent?.role ?? null,
      agent?.purpose ?? null,
    )),
  );
}

function command(
  snapshot: WorkflowSnapshot,
  jobKind: JobKind,
  targetOperatingSystem: ServerOperatingSystem | null,
  stage: string,
  agentRole: EnqueueCommand["agentRole"] = null,
  purpose: EnqueueCommand["purpose"] = null,
): EnqueueCommand {
  const poolKind = routeJob(jobKind, targetOperatingSystem ?? undefined);
  return Object.freeze({
    jobKind,
    targetOperatingSystem,
    poolKind,
    requiredCapabilities: jobCapabilities(jobKind),
    exclusive: poolKind.startsWith("E2E_"),
    idempotencyKey: `${snapshot.id}:${stage}`,
    agentRole,
    purpose,
  });
}

function appendPlatform(
  values: readonly ServerOperatingSystem[],
  value: ServerOperatingSystem,
): readonly ServerOperatingSystem[] {
  return Object.freeze([...new Set([...values, value])].sort());
}

function result(snapshot: WorkflowSnapshot, enqueue: readonly EnqueueCommand[]): WorkflowTransition {
  return Object.freeze({
    snapshot: Object.freeze(snapshot),
    enqueue: Object.freeze(enqueue),
  });
}
