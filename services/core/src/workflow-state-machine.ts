import { jobCapabilities, routeJob, type JobKind } from "@/lib/runtime/job-routing";
import type { ServerOperatingSystem } from "@/lib/runtime/server-pools";

export const WORKFLOW_STATES = [
  "DRAFT",
  "AGENT_RUNNING",
  "ASSET_GENERATING",
  "ARTIFACT_BUILDING",
  "E2E_TESTING",
  "SIGNING",
  "RELEASE_APPROVAL_PENDING",
  "STEAM_PUBLISHING",
  "CLEAN_INSTALL_VERIFYING",
  "SUCCEEDED",
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
  completedSigning: readonly ServerOperatingSystem[];
  completedCleanInstall: readonly ServerOperatingSystem[];
}>;

export type WorkflowEvent =
  | Readonly<{ kind: "SPEC_APPROVED" }>
  | Readonly<{ kind: "ASSETS_READY"; predecessorJobId: string }>
  | Readonly<{ kind: "RELEASE_APPROVED"; approvalId: string }>
  | Readonly<{ kind: "CANCEL_REQUESTED" }>
  | Readonly<{
      kind: "JOB_SUCCEEDED";
      jobId: string;
      jobKind: JobKind;
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
  "AGENT_GENERATION",
  "ARTIFACT_BUILD",
  "E2E_TEST",
  "ARTIFACT_SIGN",
  "STEAM_PUBLISH",
  "STEAM_CLEAN_INSTALL",
] as const;
export type RerunStage = typeof DELIVERY_STAGES[number];

export function deliveryStagesFor(profile: "VALIDATE" | "RELEASE"): readonly RerunStage[] {
  return profile === "VALIDATE" ? DELIVERY_STAGES.slice(0, 3) : DELIVERY_STAGES;
}

// Workflow state a stage occupies while it runs.
const STAGE_RUNNING_STATE: Readonly<Record<RerunStage, WorkflowState>> = Object.freeze({
  AGENT_GENERATION: "AGENT_RUNNING",
  ARTIFACT_BUILD: "ARTIFACT_BUILDING",
  E2E_TEST: "E2E_TESTING",
  ARTIFACT_SIGN: "SIGNING",
  STEAM_PUBLISH: "STEAM_PUBLISHING",
  STEAM_CLEAN_INSTALL: "CLEAN_INSTALL_VERIFYING",
});

// Stages that fan out one job per target platform.
const PER_PLATFORM_STAGES: ReadonlySet<RerunStage> = new Set<RerunStage>([
  "E2E_TEST", "ARTIFACT_SIGN", "STEAM_CLEAN_INSTALL",
]);

// Per-platform progress that a rerun of a given stage invalidates.
const STAGE_PROGRESS_KEY: Readonly<Partial<Record<RerunStage, keyof WorkflowSnapshot>>> = Object.freeze({
  E2E_TEST: "completedE2e",
  ARTIFACT_SIGN: "completedSigning",
  STEAM_CLEAN_INSTALL: "completedCleanInstall",
});

export type EnqueueCommand = Readonly<{
  jobKind: JobKind;
  targetOperatingSystem: ServerOperatingSystem | null;
  poolKind: ReturnType<typeof routeJob>;
  requiredCapabilities: readonly string[];
  exclusive: boolean;
  idempotencyKey: string;
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
    completedSigning: Object.freeze([]),
    completedCleanInstall: Object.freeze([]),
  });
}

export function transitionWorkflow(snapshot: WorkflowSnapshot, event: WorkflowEvent): WorkflowTransition {
  // A rerun is the one event that legitimately reopens a terminal workflow, so
  // it has to be handled before the terminal-state guard below.
  if (event.kind === "STAGE_RERUN_REQUESTED") return rerunStage(snapshot, event.stage, event.signalId);
  if (["SUCCEEDED", "FAILED", "CANCELLED"].includes(snapshot.state)) {
    return Object.freeze({ snapshot, enqueue: Object.freeze([]) });
  }
  if (event.kind === "CANCEL_REQUESTED") return result({ ...snapshot, state: "CANCELLED" }, []);
  if (event.kind === "JOB_FAILED") return result({ ...snapshot, state: "FAILED" }, []);
  if (event.kind === "SPEC_APPROVED" && snapshot.state === "DRAFT") {
    return result({ ...snapshot, state: "AGENT_RUNNING" }, [command(snapshot, "AGENT_GENERATION", null, "agent")]);
  }
  if (event.kind === "ASSETS_READY" && snapshot.state === "ASSET_GENERATING") {
    return result(
      { ...snapshot, state: "ARTIFACT_BUILDING" },
      [command(snapshot, "ARTIFACT_BUILD", null, `artifact:after:${event.predecessorJobId}`)],
    );
  }
  if (event.kind === "RELEASE_APPROVED" && snapshot.state === "RELEASE_APPROVAL_PENDING") {
    return result(
      { ...snapshot, state: "STEAM_PUBLISHING" },
      [command(snapshot, "STEAM_PUBLISH", null, `publish:approved:${event.approvalId}`)],
    );
  }
  if (event.kind !== "JOB_SUCCEEDED") throw new Error(`Event ${event.kind} is invalid for ${snapshot.state}`);

  if (snapshot.state === "AGENT_RUNNING" && event.jobKind === "AGENT_GENERATION") {
    if (event.waitForAssets) return result({ ...snapshot, state: "ASSET_GENERATING" }, []);
    return result(
      { ...snapshot, state: "ARTIFACT_BUILDING" },
      [command(snapshot, "ARTIFACT_BUILD", null, `artifact:after:${event.jobId}`)],
    );
  }
  if (snapshot.state === "ARTIFACT_BUILDING" && event.jobKind === "ARTIFACT_BUILD") {
    return result(
      { ...snapshot, state: "E2E_TESTING" },
      snapshot.targetPlatforms.map(platform => command(
        snapshot, "E2E_TEST", platform, `e2e:${platform}:after:${event.jobId}`,
      )),
    );
  }
  if (snapshot.state === "E2E_TESTING" && event.jobKind === "E2E_TEST" && event.targetOperatingSystem) {
    const completedE2e = appendPlatform(snapshot.completedE2e, event.targetOperatingSystem);
    if (completedE2e.length < snapshot.targetPlatforms.length) return result({ ...snapshot, completedE2e }, []);
    if (snapshot.profile === "VALIDATE") return result({ ...snapshot, state: "SUCCEEDED", completedE2e }, []);
    return result(
      { ...snapshot, state: "SIGNING", completedE2e },
      snapshot.targetPlatforms.map(platform => command(
        snapshot, "ARTIFACT_SIGN", platform, `sign:${platform}:after:${event.jobId}`,
      )),
    );
  }
  if (snapshot.state === "SIGNING" && event.jobKind === "ARTIFACT_SIGN" && event.targetOperatingSystem) {
    const completedSigning = appendPlatform(snapshot.completedSigning, event.targetOperatingSystem);
    if (completedSigning.length < snapshot.targetPlatforms.length) return result({ ...snapshot, completedSigning }, []);
    // Signing proves that the exact build is releasable. Publishing is an
    // irreversible external mutation, so it waits for a separate human signal.
    return result({ ...snapshot, state: "RELEASE_APPROVAL_PENDING", completedSigning }, []);
  }
  if (snapshot.state === "STEAM_PUBLISHING" && event.jobKind === "STEAM_PUBLISH") {
    return result(
      { ...snapshot, state: "CLEAN_INSTALL_VERIFYING" },
      snapshot.targetPlatforms.map(platform => command(
        snapshot, "STEAM_CLEAN_INSTALL", platform, `clean-install:${platform}:after:${event.jobId}`,
      )),
    );
  }
  if (snapshot.state === "CLEAN_INSTALL_VERIFYING"
    && event.jobKind === "STEAM_CLEAN_INSTALL"
    && event.targetOperatingSystem) {
    const completedCleanInstall = appendPlatform(snapshot.completedCleanInstall, event.targetOperatingSystem);
    return result({
      ...snapshot,
      state: completedCleanInstall.length === snapshot.targetPlatforms.length ? "SUCCEEDED" : snapshot.state,
      completedCleanInstall,
    }, []);
  }
  throw new Error(`Job ${event.jobKind} is invalid for ${snapshot.state}`);
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
  if (!["SUCCEEDED", "FAILED", "CANCELLED"].includes(snapshot.state)) {
    throw new Error("Stage rerun requires a terminal workflow; cancel the running delivery first");
  }
  const supersededFrom = stages.indexOf(stage);
  const reset: Record<string, unknown> = {};
  for (const downstream of stages.slice(supersededFrom)) {
    const key = STAGE_PROGRESS_KEY[downstream];
    if (key) reset[key] = Object.freeze([]);
  }
  const next = { ...snapshot, ...reset, state: STAGE_RUNNING_STATE[stage] } as WorkflowSnapshot;
  const platforms = PER_PLATFORM_STAGES.has(stage) ? snapshot.targetPlatforms : [null];
  return result(
    next,
    platforms.map(platform => command(
      snapshot, stage, platform, `rerun:${stage}:${platform ?? "all"}:${signalId}`,
    )),
  );
}

function command(
  snapshot: WorkflowSnapshot,
  jobKind: JobKind,
  targetOperatingSystem: ServerOperatingSystem | null,
  stage: string,
): EnqueueCommand {
  const poolKind = routeJob(jobKind, targetOperatingSystem ?? undefined);
  return Object.freeze({
    jobKind,
    targetOperatingSystem,
    poolKind,
    requiredCapabilities: jobCapabilities(jobKind),
    exclusive: poolKind.startsWith("E2E_"),
    idempotencyKey: `${snapshot.id}:${stage}`,
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
